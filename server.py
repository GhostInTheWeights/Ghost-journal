"""Ghost Journal: local trading journal server.

Serves the app at http://localhost:8766 and stores everything in data/journal.db (SQLite)
plus screenshots in data/images/. Only listens on 127.0.0.1.
Run:  python server.py   (or double-click start.bat)
"""
import csv
import io
import json
import os
import re
import sqlite3
import sys
import threading
import uuid
from datetime import datetime, timedelta, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
IMAGES = os.path.join(DATA, "images")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
IMAGE_TYPES = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif"}

DEFAULT_SETTINGS = {
    "start_balance": 10000,
    "currency": "$",
    "setups": ["EMA cross", "Liquidity sweep", "Key zone bounce", "Breakout", "Other"],
    "mistakes": ["FOMO entry", "Moved stop loss", "Exited too early", "Oversized", "No stop loss",
                 "Revenge trade", "Traded against trend", "Ignored my rules"],
    "emotions": ["Calm", "Confident", "Anxious", "FOMO", "Greedy", "Revenge", "Bored", "Tired"],
    "contracts": {"XAUUSD": 100, "EURUSD": 100000, "GBPUSD": 100000},
    "mt5_offset_hours": 0,
}

os.makedirs(IMAGES, exist_ok=True)
db = sqlite3.connect(os.path.join(DATA, "journal.db"), check_same_thread=False)
db.executescript("""
CREATE TABLE IF NOT EXISTS trades (id INTEGER PRIMARY KEY AUTOINCREMENT, ext_id TEXT UNIQUE, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS days (date TEXT PRIMARY KEY, notes TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
""")
lock = threading.Lock()


def get_settings():
    s = dict(DEFAULT_SETTINGS)
    for k, v in db.execute("SELECT key, value FROM settings"):
        s[k] = json.loads(v)
    return s


def all_trades():
    return [{**json.loads(d), "id": i} for i, d in db.execute("SELECT id, data FROM trades ORDER BY id")]


def insert_trade(t, ext_id=None):
    t = {k: v for k, v in t.items() if k != "id"}
    cur = db.execute("INSERT OR IGNORE INTO trades (ext_id, data) VALUES (?, ?)", (ext_id, json.dumps(t)))
    return cur.rowcount == 1


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ───────────── imports ─────────────
def import_mt5(days):
    try:
        import MetaTrader5 as mt5
    except ImportError:
        raise ValueError("The MetaTrader5 Python package is missing. Run:  pip install MetaTrader5")
    if not mt5.initialize():
        raise ValueError(f"Could not connect to MetaTrader 5. Is it open and logged in? ({mt5.last_error()})")
    try:
        acc = mt5.account_info()
        account = f"MT5 {'Demo' if acc.trade_mode == 0 else 'Live'} {acc.login}"
        offset = float(get_settings().get("mt5_offset_hours", 0)) * 3600
        end = datetime.now(timezone.utc) + timedelta(days=1)
        deals = mt5.history_deals_get(end - timedelta(days=days + 1), end) or []
        by_pos = {}
        for d in deals:
            if d.position_id and d.entry in (0, 1, 3):          # IN, OUT, OUT_BY
                by_pos.setdefault(d.position_id, []).append(d)
        added = skipped = 0
        for pid, ds in by_pos.items():
            ins = [d for d in ds if d.entry == 0]
            outs = [d for d in ds if d.entry in (1, 3)]
            vin, vout = sum(d.volume for d in ins), sum(d.volume for d in outs)
            if not ins or not outs or abs(vin - vout) > 1e-6:
                continue                                         # still open or partial
            side = "buy" if ins[0].type == 0 else "sell"
            orders = mt5.history_orders_get(position=pid) or []
            sl = next((o.sl for o in orders if o.sl), None)
            tp = next((o.tp for o in orders if o.tp), None)
            reason = {4: "SL", 5: "TP"}.get(outs[-1].reason, "Manual")
            t = {
                "account": account, "source": "mt5", "symbol": ins[0].symbol, "side": side, "lots": round(vin, 2),
                "open_time": iso(min(d.time for d in ins) - offset), "close_time": iso(max(d.time for d in outs) - offset),
                "entry": round(sum(d.price * d.volume for d in ins) / vin, 5),
                "exit": round(sum(d.price * d.volume for d in outs) / vout, 5),
                "sl": sl, "tp": tp, "exit_reason": reason,
                "pnl": round(sum(d.profit for d in outs), 2),
                # stored as a cost (positive = money paid); MT5 reports charges as negative numbers
                "fees": round(-sum(d.commission + d.swap + d.fee for d in ds), 2),
                "setup": "", "notes": "", "mistakes": [], "images": [], "plan_followed": "",
            }
            if insert_trade(t, f"mt5:{acc.login}:{pid}"):
                added += 1
            else:
                skipped += 1
        db.commit()
        return {"added": added, "skipped": skipped, "account": account}
    finally:
        mt5.shutdown()


def import_ghost_csv(text):
    """Trades CSV exported from Ghost Charts (Stats tab -> Export trades CSV)."""
    rows = list(csv.DictReader(io.StringIO(text)))
    need = {"symbol", "side", "qty", "open_time_utc", "entry", "close_time_utc", "exit", "pnl"}
    if not rows or not need <= set(rows[0]):
        raise ValueError("This doesn't look like a Ghost Charts trades CSV (columns: " + ", ".join(sorted(need)) + ").")
    added = skipped = 0
    num = lambda v: float(v) if v not in ("", None) else None
    for r in rows:
        t = {
            "account": "Backtest (Ghost Charts)", "source": "backtest", "symbol": r["symbol"], "side": r["side"],
            "lots": num(r["qty"]), "open_time": r["open_time_utc"].replace(".000Z", "Z"),
            "close_time": r["close_time_utc"].replace(".000Z", "Z"), "entry": num(r["entry"]), "exit": num(r["exit"]),
            "sl": num(r.get("sl")), "tp": num(r.get("tp")), "exit_reason": r.get("reason", ""), "pnl": num(r["pnl"]),
            "fees": 0, "setup": "", "notes": "", "mistakes": [], "images": [], "plan_followed": "",
        }
        ext = f"gc:{r['symbol']}:{r['open_time_utc']}:{r['entry']}:{r['side']}"
        if insert_trade(t, ext):
            added += 1
        else:
            skipped += 1
    db.commit()
    return {"added": added, "skipped": skipped, "account": "Backtest (Ghost Charts)"}


EXPORT_COLS = ["id", "account", "source", "symbol", "side", "lots", "open_time", "close_time", "entry", "exit", "sl", "tp",
               "exit_reason", "pnl", "fees", "setup", "timeframe", "emotion_before", "emotion_after", "mistakes",
               "plan_followed", "rating", "notes"]


def export_csv():
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(EXPORT_COLS)
    for t in all_trades():
        w.writerow(["; ".join(t.get(c) or []) if c == "mistakes" else t.get(c, "") for c in EXPORT_COLS])
    return out.getvalue().encode("utf-8-sig")


# ───────────── HTTP ─────────────
class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def reply(self, code, obj=None, body=None, ctype="application/json"):
        body = body if body is not None else json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        return self.rfile.read(int(self.headers.get("Content-Length", 0)))

    def do_GET(self):
        p = self.path.split("?")[0]
        if p.endswith(".db"):
            return self.send_error(403)
        with lock:
            if p == "/api/trades":
                return self.reply(200, all_trades())
            if p == "/api/settings":
                return self.reply(200, get_settings())
            if p == "/api/days":
                return self.reply(200, dict(db.execute("SELECT date, notes FROM days")))
            if p == "/api/export.csv":
                return self.reply(200, body=export_csv(), ctype="text/csv; charset=utf-8")
        return super().do_GET()

    def do_POST(self):
        p = self.path
        try:
            with lock:
                if p == "/api/trades":
                    cur = db.execute("INSERT INTO trades (data) VALUES (?)", (json.dumps(json.loads(self.body())),))
                    db.commit()
                    return self.reply(200, {"id": cur.lastrowid})
                if p == "/api/images":
                    ext = IMAGE_TYPES.get(self.headers.get("Content-Type", "").split(";")[0])
                    if not ext:
                        return self.reply(400, {"error": "Only PNG, JPEG, WebP or GIF images."})
                    name = uuid.uuid4().hex + ext
                    with open(os.path.join(IMAGES, name), "wb") as f:
                        f.write(self.body())
                    return self.reply(200, {"name": name})
                if p == "/api/import/mt5":
                    days = int(json.loads(self.body() or b"{}").get("days", 90))
                    return self.reply(200, import_mt5(days))
                if p == "/api/import/csv":
                    return self.reply(200, import_ghost_csv(self.body().decode("utf-8-sig")))
        except (ValueError, KeyError) as e:
            return self.reply(400, {"error": str(e)})
        self.send_error(404)

    def do_PUT(self):
        p = self.path
        with lock:
            m = re.fullmatch(r"/api/trades/(\d+)", p)
            if m:
                t = {k: v for k, v in json.loads(self.body()).items() if k != "id"}
                db.execute("UPDATE trades SET data = ? WHERE id = ?", (json.dumps(t), int(m.group(1))))
                db.commit()
                return self.reply(200, {"ok": True})
            if p == "/api/settings":
                for k, v in json.loads(self.body()).items():
                    db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (k, json.dumps(v)))
                db.commit()
                return self.reply(200, get_settings())
            m = re.fullmatch(r"/api/days/(\d{4}-\d{2}-\d{2})", p)
            if m:
                notes = json.loads(self.body()).get("notes", "")
                if notes.strip():
                    db.execute("INSERT OR REPLACE INTO days (date, notes) VALUES (?, ?)", (m.group(1), notes))
                else:
                    db.execute("DELETE FROM days WHERE date = ?", (m.group(1),))
                db.commit()
                return self.reply(200, {"ok": True})
        self.send_error(404)

    def do_DELETE(self):
        m = re.fullmatch(r"/api/trades/(\d+)", self.path)
        if not m:
            return self.send_error(404)
        with lock:
            row = db.execute("SELECT data FROM trades WHERE id = ?", (int(m.group(1)),)).fetchone()
            if row:
                for name in json.loads(row[0]).get("images") or []:
                    path = os.path.join(IMAGES, os.path.basename(name))
                    if os.path.exists(path):
                        os.remove(path)
                db.execute("DELETE FROM trades WHERE id = ?", (int(m.group(1)),))
                db.commit()
        return self.reply(200, {"ok": True})

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), partial(Handler, directory=HERE))
    print(f"Ghost Journal running at http://localhost:{PORT}  (close this window to stop)")
    srv.serve_forever()
