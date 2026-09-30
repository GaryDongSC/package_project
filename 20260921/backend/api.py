import os
import json

from flask import Flask, render_template, request
from flask_socketio import SocketIO, join_room, leave_room
from datetime import datetime
import sqlite3
import logic,route
import logging

log = logging.getLogger('werkzeug')
log.setLevel(logging.ERROR)

def machine_room(machine_id):
    return f"machine:{machine_id}"

DB_PATH = os.path.join(
    os.path.dirname(__file__),
    "database",
    "factory.db"
)
app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins='*') # logger=True, # engineio_logger=True)
route.init(app, socketio)

def init_machines():
    print("init_machines 開始執行")
    print("DB_PATH：", DB_PATH)

    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.cursor()
        cursor.execute("""
                SELECT
                datetime('now'),
                datetime('now', 'localtime'),
                datetime('now', '+8 hours'),
                date('now', '+8 hours')
                """)
        
        print("SQLite 時間：", cursor.fetchone())
        print("Python datetime.now：", datetime.now())
        print("DB_PATH：", DB_PATH)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS machine_records (
                id TEXT NOT NULL,
                d TEXT NOT NULL,
                t TEXT NOT NULL,
                s TEXT NOT NULL,
                a REAL NOT NULL,
                v INTEGER NOT NULL,
                sa REAL NOT NULL,
                sv INTEGER NOT NULL,
                c INTEGER NOT NULL
            )
        """)

        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_machine_date_time
            ON machine_records(id, d, t)
        """)

        cursor.execute("""
            WITH RECURSIVE machines(id, n) AS (
                SELECT 'S-A', 1

                UNION ALL

                SELECT
                    CASE
                        WHEN n + 1 <= 15 THEN
                            'S-' || char(64 + n + 1)
                        ELSE
                            'PG-' || char(64 + n - 14)
                    END,
                    n + 1
                FROM machines
                WHERE n < 18
            )
            INSERT INTO machine_records (
                id, d, t, s, a, v, sa, sv, c
            )
            SELECT
                id,
                date('now', '+8 hours'),
                '07:30:00',
                'Offline',
                0,
                0,
                0,
                0,
                0
            FROM machines
            WHERE NOT EXISTS (
                SELECT 1
                FROM machine_records mr
                WHERE mr.id = machines.id
                AND mr.d = date('now', '+8 hours')
            )
        """)


        conn.commit()

        cursor.execute("""
            SELECT COUNT(*)
            FROM machine_records""")
        print("commit*後總筆數：", cursor.fetchone()[0])

        cursor.execute("""
           SELECT DISTINCT d
            FROM machine_records
            ORDER BY d DESC
        """)
        print("資料庫日期：", cursor.fetchall())

        cursor.execute("""
            SELECT DISTINCT id
            FROM machine_records
            ORDER BY
                CASE
                    WHEN id LIKE 'S-%' THEN 1
                    WHEN id LIKE 'PG-%' THEN 2
                    ELSE 3
                END,
                id
        """)
        machine_ids = [row[0] for row in cursor.fetchall()]

        print("machine_ids 數量：", len(machine_ids))
        print("machine_ids：", machine_ids)
        print("init_machines 執行完成")
        conn.commit()

    for machine_id in machine_ids:
        if machine_id not in logic.machines:
            logic.machines[machine_id] = logic.Machine(machine_id)


init_machines()

def status_lamp():
    date = datetime.now().strftime("%Y-%m-%d")
    statuses = []

    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.cursor()

        cursor.execute("""
            SELECT
                id,
                d,
                t,
                s,
                a,
                v,
                sa,
                sv,
                c
            FROM (
                SELECT
                    id,
                    d,
                    t,
                    s,
                    a,
                    v,
                    sa,
                    sv,
                    c,
                    ROW_NUMBER() OVER (
                        PARTITION BY id
                        ORDER BY t DESC
                    ) AS rn
                FROM machine_records
                WHERE d = ?
            )
            WHERE rn = 1
            ORDER BY
                CASE
                    WHEN id LIKE 'S-%' THEN 1
                    WHEN id LIKE 'PG-%' THEN 2
                    ELSE 3
                END,
                id
        """, (date,))

        rows = cursor.fetchall()

    for row in rows:
        machine_id = row[0]
        status = row[3]

        statuses.append({
            "id": machine_id,
            "s": status[0]
        })

    return statuses

@socketio.on("lamp_date")
def status_date_init():
    socketio.emit( "init_toolbar", { "statuses":status_lamp() }, room=request.sid )


def lamp_update(data):
    socketio.emit( "lamp_updated", { "statuses": [{ "id": data["device_id"], "s": data["status"][0] }] } )
route.set_calllamp(lamp_update)


def load_test_sensor(selected_machine,date):

    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row

        cursor = conn.cursor()
        cursor.execute("""
            SELECT
                id,
                d,
                t,
                s,
                a,
                v,
                sa,
                sv,
                c
            FROM machine_records
            WHERE id = ?
                AND d = ?
            ORDER BY t
        """,(selected_machine,date))
        rows = cursor.fetchall()
    

    records=[]
    for row in rows:
        records.append({
            "id": row["id"],
            "d": row["d"],
            "t": row["t"],
            "s": row["s"],
            "a": row["a"],
            "v": row["v"],
            "sa": row["sa"],
            "sv": row["sv"],
            "c": row["c"]
        })
    return records

@app.route('/')
def index():
    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.cursor()
        cursor.execute(""" SELECT DISTINCT d FROM machine_records ORDER BY d """)
        dates = [row[0] for row in cursor.fetchall()]
        cursor.execute(""" SELECT DISTINCT id FROM machine_records ORDER BY id """)
        machines = [row[0] for row in cursor.fetchall()]
    return render_template( 'site.html', dates=dates ,machines=machines)

@socketio.on('connect')
def handle_connect():
    socketio.emit('connected',{'status': 'ok'},room=request.sid)    # 前端要求目前資料

@socketio.on("request_init")
def handle_request_init():
    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT DISTINCT d
            FROM machine_records
            ORDER BY d
        """)
        dates = [row[0] for row in cursor.fetchall()]
    if not dates:
        dates = [datetime.now().strftime("%Y-%m-%d")]
    dates = [d.replace('-', '')[2:] for d in dates]
    socketio.emit( "init_date", { "dates":dates }, room=request.sid ) 


@socketio.on("request_data")
def handle_request_data(data):
    machine_ids = data["machine_id"]
    date = data["date"]
    request_id = data.get("request_id")
    if not isinstance(machine_ids, list):
        machine_ids = [machine_ids]
    socketio.start_background_task( process_machine_data, machine_ids, date, request.sid, request_id)

def process_machine_data(machine_ids, date, sid, request_id):
    for machine_id in machine_ids:
        sensor = load_test_sensor(machine_id, date)
        if not sensor:
            machine_data = {
            "realtime": False,
            "request_id": request_id,
            "date": date,
            "power": {
            "id": machine_id,
            "l": [],
            "w": [],
            "v": [],
            "sw": [],
            "sv": [],
            "c": []
            },
            "output": None,
            "history": []
            }

            socketio.emit( "machine_updated", machine_data, room=sid )

            continue
        machine = logic.Machine(machine_id)
        #     machine.reset()
        # else: machine = logic.machines[machine_id]
        power_data = {
            "id": machine_id,
            "l": [],
            "w": [],
            "v": [],
            "sw": [],
            "sv": [],
            "c": []
        }
        status_history = []
        last_status = None
        output = None
        for record in sensor:
            machine.update(record)
            machine.loop()
            output = machine.output()
            power_data["l"].append(record["t"][:2] + record["t"][3:5])
            power_data["w"].append(machine.w)
            power_data["v"].append(machine.v)
            power_data["sw"].append(machine.sw)
            power_data["sv"].append(machine.sv)
            power_data["c"].append(record["c"])
            if machine.status != last_status or len(record) == 0:
                status_history.append({ "id": machine_id, "t": record["t"][:2] + record["t"][3:5], "s": output["s"][0] })
                last_status = machine.status
            if date == datetime.now().strftime("%Y-%m-%d") and status_history and datetime.now().strftime("%H%M") <= status_history[-1]["t"]:
                status_history.append({ "id": machine_id, "t": datetime.now().strftime("%H%M"), "s": output["s"][0] })
                break
        if date != datetime.now().strftime("%Y-%m-%d") and status_history and "2130" not in status_history[-1]["t"]:
            status_history.append({ "id": machine_id, "t": "2130", "s": status_history[-1]["s"] })
        
        machine_data = {"realtime":False ,"request_id": request_id, "date": date,"power": power_data, "output": output, "history": status_history }
        socketio.emit( "machine_updated", machine_data, room=sid )


machine_cache = {}

@socketio.on("sensor_data")
def sensor_update(data):
    machine_id = data["device_id"]
    if machine_id not in logic.machines:
        return
    fixed = {
        "id": data["device_id"],
        "d": data["timestamp"][:10],
        "t": data["timestamp"][11:19],
        "s": data["status"],
        "a": data["current"],
        "v": data["voltage"],
        "sa": data["seal_current"],
        "sv": data["seal_voltage"],
        "c": data["counter"]
    }
    machine = logic.machines[machine_id]
    # -------------------------
    # 即時更新 machine 狀態
    # -------------------------
    machine.update(fixed)
    machine.loop()
    output = machine.output()
    current_date = datetime.now().strftime("%Y-%m-%d")
    # ------------------------
    # 建立快取
    # ------------------------
    if machine_id not in machine_cache:
        machine_cache[machine_id] = {
            "date": current_date,
            "last_status": output["s"][0],
            "power": {
                "id": machine_id,
                "l": [],
                "w": [],
                "v": [],
                "sw": [],
                "sv": [],
                "c": []
            },
            "history": []
        }
    cache = machine_cache[machine_id]
    # -------------------------
    # 跨日重置快取
    # -------------------------
    if cache["date"] != current_date:
        cache["date"] = current_date
        cache["power"] = {
            "id": machine_id,
            "l": [],
            "w": [],
            "v": [],
            "sw": [],
            "sv": [],
            "c": []
        }
        cache["history"] = []
        cache["last_status"] = output["s"][0]
    # -------------------------
    # power 資料直接累加
    # -------------------------
    cache["power"]["l"].append( fixed["t"][:2] + fixed["t"][3:5] )
    cache["power"]["w"].append(machine.w)
    cache["power"]["v"].append(machine.v)
    cache["power"]["sw"].append(machine.sw)
    cache["power"]["sv"].append(machine.sv)
    cache["power"]["c"].append(fixed["c"])
    # -------------------------
    # 只在狀態改變時紀錄 timeline
    # -------------------------
    current_status = output["s"][0]
    if current_status != cache["last_status"]:
        cache["history"].append({
            "id": machine_id,
            "t": fixed["t"][:2] + fixed["t"][3:5],
            "s": current_status
        })
        cache["last_status"] = current_status
    # -------------------------
    # 推送增量資料
    # -------------------------
    machine_data = {
        "realtime": True,
        "power": {
            "id": machine_id,
            "l": [cache["power"]["l"][-1]],
            "w": [cache["power"]["w"][-1]],
            "v": [cache["power"]["v"][-1]],
            "sw": [cache["power"]["sw"][-1]],
            "sv": [cache["power"]["sv"][-1]],
            "c": [cache["power"]["c"][-1]]
        },
        "output": output,
        "history": cache["history"][-1:] if cache["history"] else []
    }
    socketio.emit("machine_updated", machine_data,room=machine_room(machine_id))
route.set_callback(sensor_update)

@socketio.on("subscribe_machines")
def handle_subscribe_machines(data):
    machine_ids = data.get("machine_ids", [])

    if not isinstance(machine_ids, list):
        machine_ids = [machine_ids]
    # subscribed = []
    for machine_id in machine_ids:
        if machine_id not in logic.machines:
            continue
        join_room(machine_room(machine_id))
        # subscribed.append(machine_id)
    # socketio.emit(
    #     "subscription_updated", { "action": "subscribe", "machine_ids": subscribed },
    #     room=request.sid
    # )

@socketio.on("unsubscribe_machines")
def handle_unsubscribe_machines(data):
    machine_ids = data.get("machine_ids", [])

    if not isinstance(machine_ids, list):
        machine_ids = [machine_ids]
    # unsubscribed = []
    for machine_id in machine_ids:
        leave_room(machine_room(machine_id))
        # unsubscribed.append(machine_id)
    # socketio.emit(
    #     "subscription_updated", { "action": "unsubscribe", "machine_ids": unsubscribed },
    #     room=request.sid
    # )

if __name__ == '__main__':
    port = int(os.environ.get('PORT',7200))
    socketio.run(app,host='0.0.0.0',port=port,debug=False)