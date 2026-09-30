def timetrans(t):
    h, m, *_ = t.split(":")
    return int(h) * 60 + int(m)

class Machine:

    def __init__(self, machine_id):

        self.machine_id = machine_id
        self.reset()

    def reset(self):

        self.status = "Offline"

        self.w = 0.0
        self.sw = 0.0
        self.v = 0.0
        self.a = 0.0
        self.sv = 0.0
        self.sa = 0.0

        self.idle_now = 0
        self.idle_time = 0
        self.idle_times = 0

        self.init_time = 450
        self.runtime = 0
        self.total_time = 0

        self.bags = 0
        self.total_bags = 0
        self.bagpersec = 0.0

        self.wt = 0
        self.kwh = 0.0
        self.wh_per_bag = 0.0

        self.utilization = 0.0

        self.t = ""
        self.idle_check = [0,0]
        self.run_go_on = 0
        self.rundone = 0
    def update(self,data):
        self.status = data["s"]
        self.t = timetrans(data["t"])
        self.a = data["a"]
        self.v = data["v"]
        self.sa = data["sa"]
        self.sv = data["sv"]
        self.bags = data["c"]

    def loop(self):
        self.total_time = max(0,self.t - self.init_time + 1)
        self.w = round(self.v * self.a , 3)
        self.sw = round(self.sv * self.sa , 3) if self.sv != -1 else -1
        self.wt += self.w + self.sw if self.sv != -1 else self.w
        if self.bags == 0:
            if ( self.idle_check[0] == 0 or self.t - self.idle_check[1] > 1 ):
                self.idle_check[0] = self.t
                self.idle_check[1] = self.t

            elif self.t - self.idle_check[1] == 1: 
                self.idle_check[1] = self.t
            idle_duration = ( self.idle_check[1] - self.idle_check[0] )
            if idle_duration >= 4:
                if idle_duration == 4:
                    self.idle_times += 1
                    self.idle_now += 5
                    self.idle_time += 5
                else:
                    self.idle_now += 1
                    self.idle_time += 1
        else:
            self.total_bags += self.bags
            self.idle_now = 0
            # 結束這一次連續零產量的追蹤
            self.idle_check = [0, 0]
            
        if self.total_bags == 0 :
            self.total_time = 0 
        # 有效運轉時間
    
        self.runtime = self.total_time - self.idle_time

        if self.total_time > 0:
            self.utilization = round( self.runtime / self.total_time * 100, 2 )
            self.bagpersec = round( self.total_bags / self.total_time, 2 )
        else:
            self.utilization = 0.0
            self.bagpersec = 0.0
        self.kwh = round( self.wt / 60000, 3 )
        self.wh_per_bag = ( round(self.kwh / self.total_bags * 1000, 2) if self.total_bags > 0 else 0 )

        
    def output(self):

        return {
            "t": self.t,#time
            "s": self.status,#status
            "id": self.machine_id,#machine_id
            "v": self.v,#voltage
            "w": self.w,#power
            "sv": self.sv,#seal_voltage
            "sw": self.sw,#seal_power
            "b": self.total_bags,#total_bags
            "bps": self.bagpersec,#bagpersec
            "i": self.idle_now,#idle_now
            "it": self.idle_time,#idle_time
            "its": self.idle_times,#idle_times
            "kwh": self.kwh,#kwh
            "wpb": self.wh_per_bag,#wh_per_bag
            "u":self.utilization#utilization
        }

machines = {}