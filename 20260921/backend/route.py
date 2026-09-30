from flask import request, jsonify
import sqlite3,os,time
from datetime import datetime
import subprocess
_callback = None
_calllamp = None
import threading

env = os.environ.copy()
env["HOME"] = "/root"

def set_callback(func):
    global _callback
    _callback = func

def set_calllamp(func):
    global _calllamp
    _calllamp = func

app = None
socketio = None

DB_PATH = os.path.join(
os.path.dirname(__file__),
"database",
"factory.db"
)

BACKUP_PATH = DB_PATH[:-3] + "back.db"

env = os.environ.copy()
env["HOME"] = "/root"

def sync_worker():
    print("[SYNC] worker started", flush=True)

    last_sync_date = None

    while True:
        now = datetime.now()

        try:
            if (
                now.hour == 12
                and now.minute == 0
                and last_sync_date != now.date()
            ):
                print("[SYNC] start daily sync", flush=True)

                success = sync_to_wsl()

                if success:
                    print("[SYNC] success", flush=True)
                else:
                    print("[SYNC] failed", flush=True)

                last_sync_date = now.date()

        except Exception as e:
            print(f"[SYNC ERROR] {e}", flush=True)

        time.sleep(30)

def sync_to_wsl():
    TARGET_IP = "192.168.100.95"
    TARGET_USER = "garry"

    try:
        os.makedirs("/root/.ssh", exist_ok=True)
        # known_hosts
        subprocess.run(
            ["ssh-keyscan", "-H", TARGET_IP],
            stdout=open("/root/.ssh/known_hosts", "a"),
            stderr=subprocess.DEVNULL
        )
        # 建立備份檔
        with sqlite3.connect(DB_PATH) as source:
            with sqlite3.connect(BACKUP_PATH) as target:
                source.backup(target)
                
        print(f"[SYNC] backup created: {BACKUP_PATH}", flush=True)
        # 先測試SSH連線
        probe = subprocess.run(
            [
                "ssh",
                "-i", "/root/.ssh/id_ed25519",
                "-o", "IdentitiesOnly=yes",
                "-o", "ConnectTimeout=5",
                "-o", "BatchMode=yes",
                f"{TARGET_USER}@{TARGET_IP}",
                "echo ok"
            ],
        env=env,
        capture_output=True,
        text=True
        )
        if probe.returncode != 0:
            print( f"[SYNC] target offline: {probe.stderr.strip()}", flush=True )
            return False
        # SCP傳送
        result = subprocess.run(
            [ "/usr/bin/scp",
            "-i", "/root/.ssh/id_ed25519",
            "-o", "IdentitiesOnly=yes",
            BACKUP_PATH,
            f"{TARGET_USER}@{TARGET_IP}:/home/{TARGET_USER}/project/backup/factory.db" 
            ],
        env=env,
        capture_output=True,
        text=True,
        timeout=30
        )
        print( f"[SYNC] scp return code: {result.returncode}", flush=True )

        if result.stdout:
            print( f"[SYNC] scp stdout: {result.stdout}", flush=True )

        if result.stderr:
            print( f"[SYNC] scp stderr: {result.stderr}", flush=True )

        if result.returncode != 0:
            return False
        
        if os.path.exists(BACKUP_PATH):
            os.remove(BACKUP_PATH)
        return True
    
    except subprocess.TimeoutExpired:
        print("[SYNC] scp timeout", flush=True)
        return False
    except Exception as e:
        print(f"[SYNC] exception: {e}", flush=True)
        return False



def init(flask_app, sio):
    global app
    global socketio
    app = flask_app
    socketio = sio
    register_routes()
    threading.Thread( target=sync_worker, daemon=True ).start()

def insert_sensor(data):
    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.cursor()
        status = (
            "Break"
            if "12:00:00" <= data["timestamp"][11:19] < "13:00:00" or "17:00:00" <= data["timestamp"][11:19] < "17:30:00"
            else data["status"]
        )

        cursor.execute(
            """
            INSERT INTO machine_records
            (
                id,
                d,
                t,
                s,
                a,
                v,
                sa,
                sv,
                c
            )
            VALUES
            (?,?,?,?,?,?,?,?,?)
            """,
            (
                data["device_id"],
                data["timestamp"][:10],
                data["timestamp"][11:19],
                status,
                data["current"],
                data["voltage"],
                data["seal_current"] or -1,
                data["seal_voltage"] or -1,
                data["counter"]
            )

        )
        conn.commit()


def register_routes():
    @app.route( "/api/iot/signal", methods=["POST","GET"])
    def receive_sensor():
        data = request.json
        insert_sensor(data)
        _callback(data)
        _calllamp(data)
        return jsonify( { "status":"success" } )