let display = false
function createUtilizationChart(canvas){
return new Chart(canvas,{ 
    type:'doughnut', 
    data:{ 
        labels:[ "稼動", "停機" ], 
        datasets:[ { data:[ 0, 100 ], 
            backgroundColor:[ '#36A2EB', '#ffffff' ],
            borderColor: "transparent",
            borderWidth: 0,
            hoverBorderColor: "transparent",
            hoverBorderWidth: 0, 
        }]}, 
    options:{ responsive:true,maintainAspectRatio: false, 
        plugins:{ 
            legend:{ display: !display,
                position:'bottom',
                labels :{ color:'#ffffff' }, 
                onClick:()=>{} }, 
            title:{ 
                    display:true, 
                    text:"設備稼動率", 
                    color:'#ffffff' ,
                    font:{size:18,weight:'normal'}},
            tooltip:{enabled:false}
        }}});}

function createPowerChart(canvas){
return new Chart(canvas,{ 
    type:'line', 
    data:{ labels:[], 
        datasets:[ 
            { label:"功率(W)", data:[], borderColor:"#00ff00", yAxisID:"LeftAxis" },
            { label:"電壓(V)", data:[], borderColor:"#00ffff", yAxisID:"RightAxis" },
            { label:"期間產量", data:[], borderColor:"#ee8c0c", yAxisID:"LeftAxis" },
            { label:"封口功率(W)", data:[], borderColor:"#00ff00", yAxisID:"LeftAxis" },
            { label:"封口電壓(V)", data:[], borderColor:"#00ffff", yAxisID:"RightAxis" }]} ,
    options:{ animation:false, responsive:true, maintainAspectRatio: false,scales:{ 
        x:{ ticks:{ display:false } }, 
        LeftAxis:{ position:"left",ticks:{ color: "#ffffff"} }, 
        RightAxis:{ position:"right", grid: {drawOnChartArea: false},ticks:{  color: "#ffffff"} }},// 避免左右Y軸格線重疊
        plugins:{
            legend:{
                labels:{ 
                    color:'#ffffff',
                    filter: function(item, chart) { return item.text !== ""; } 
                }, 
                    onClick:(event, legendItem, legend)=>{
                        const chart = legend.chart;
                        const dataset = chart.data.datasets[legendItem.datasetIndex];
                        dataset.borderWidth = dataset.borderWidth === 4 ? 2 : 4;
                        chart.update();
                    }}}}});}

let selectedMachines = [];
const machineHistory = {};
const dashboards = {};
const socket = io("http://192.168.100.95:7200");
let currentYear = null;
let currentMonth = null;
let currentDate = null;
let availableDates = [];
const dateSelect = document.getElementById("dateSelect");
const monthSelect = document.getElementById("monthSelect");
const yearSelect = document.getElementById("yearSelect");
let timelineHoverIndex = -1;
const startMinute = 7 * 60 + 30;
const endMinute = 21 * 60 + 30;
let machinehead = null;
const displayCharts = {};
let subscribedMachines = new Set();
// 正在等待 snapshot 的機台
const pendingSnapshots = new Map();
// snapshot 載入期間收到的 realtime data
const realtimeBuffers = new Map();
let snapshotRequestId = 0;
let multiple = false;
const STATUS_CONFIG = {
    R: { name: "Running", className: "running", color: "#1c681c" },
    I: { name: "Idle", className: "idle", color: "#ee8c0c" },
    O: { name: "Offline", className: "offline", color: "#ff0000" },
    B: { name: "Break", className: "break", color: "#808080" }
};
const STATUS_CLASSES = Object.values(STATUS_CONFIG) .map(status => status.className);
const MACHINE_TYPE_ORDER = { S: 1, PG: 2 };



function parseMachineId(machineId) {
    const [type, number] = machineId.split("-");
    return { type, number: Number(number) };
}

function compareMachines(a, b) {
    const machineA = parseMachineId(a);
    const machineB = parseMachineId(b);
    return (
        (MACHINE_TYPE_ORDER[machineA.type] ?? 99) -
        (MACHINE_TYPE_ORDER[machineB.type] ?? 99)
    ) || machineA.number - machineB.number;
}

function normalizeStatus(status) {
    if (!status) return "B";
    if (STATUS_CONFIG[status]) return status;
    return Object.entries(STATUS_CONFIG).find(([, config]) => config.name === status)?.[0] ?? "B";
}

function applyStatusClass(element, status) {
    if (!element) return;
    const code = normalizeStatus(status);
    element.classList.remove(...STATUS_CLASSES);
    element.classList.add(STATUS_CONFIG[code].className);
}
function updateLampClass(lamp, status) {
    applyStatusClass(lamp, status);
}

function upsertRealtimePower(history, power) {
    if (!history || !Array.isArray(power?.l)) { return; }
    // 相容既有 history，避免 labelIndex 尚未建立時報錯
    if (!(history.labelIndex instanceof Map)) {
        history.labelIndex = new Map();
        rebuildLabelIndex(history);
    }
    let needsSort = false;
    for ( let index = 0; index < power.l.length; index += 1 ) {
        const label = normalizePowerLabel( power.l[index] );
        const existingIndex = history.labelIndex.get(label);
        // 已經存在相同時間，覆蓋原有資料
        if (existingIndex !== undefined) {
            history.power[existingIndex] = power.w?.[index] ?? null;
            history.voltage[existingIndex] = power.v?.[index] ?? null;
            history.seal_power[existingIndex] = power.w?.[index] ?? null;
            history.seal_voltage[existingIndex] = power.v?.[index] ?? null;
            history.bags[existingIndex] = power.c?.[index] ?? 0;
            continue;
        }
        // 新時間，附加到陣列最後面
        const newIndex = history.labels.length;
        const previousLabel = history.labels[newIndex - 1];
        history.labels.push(label);
        history.power.push( power.w?.[index] ?? null );
        history.voltage.push( power.v?.[index] ?? null );
        history.seal_power.push( power.w?.[index] ?? null );
        history.seal_voltage.push( power.v?.[index] ?? null );
        history.bags.push( power.c?.[index] ?? 0 );
        // 新增這一筆的索引，不必重建整個 Map
        history.labelIndex.set( label, newIndex );
        // 新資料早於目前最後一筆，代表發生亂序
        if ( previousLabel !== undefined && label < previousLabel ) { needsSort = true; }
    }
    // 只有真的收到亂序資料時才排序
    if (needsSort) { sortPowerHistory(history); }
}

function rebuildLabelIndex(history) {
    history.labelIndex.clear();
    history.labels.forEach((label, index) => { history.labelIndex.set(label, index); });
}

function replacePowerHistory(history, power) {
    const labels = Array.isArray(power?.l) ? power.l : [];
    history.labels = labels.map( normalizePowerLabel );
    history.power = Array.isArray(power?.w) ? [...power.w] : [];
    history.voltage = Array.isArray(power?.v) ? [...power.v] : [];
    history.seal_power = Array.isArray(power?.w) ? [...power.sw] : [];
    history.seal_voltage = Array.isArray(power?.v) ? [...power.sv] : [];
    history.bags = Array.isArray(power?.c) ? [...power.c] : [];
    rebuildLabelIndex(history);
}

function sortPowerHistory(history) {
    const rows = history.labels.map( (label, index) => ({ 
        label, 
        power: history.power[index], 
        voltage: history.voltage[index], 
        seal_power: history.seal_power[index], 
        seal_voltage: history.seal_voltage[index], 
        bags: history.bags[index] }) );
    rows.sort((a, b) => { return a.label.localeCompare(b.label); });
    history.labels = rows.map( row => row.label );
    history.power = rows.map( row => row.power );
    history.voltage = rows.map( row => row.voltage );
    history.seal_power = rows.map( row => row.seal_power );
    history.seal_voltage = rows.map( row => row.seal_voltage );
    history.bags = rows.map( row => row.bags );
    // 排序後，每個 label 的索引位置已經改變
    rebuildLabelIndex(history);
}

function normalizePowerLabel(label) {
    const value = String(label ?? "");
    if (/^\d{4}$/.test(value)) { return ( `${value.slice(0, 2)}:` + `${value.slice(2, 4)}:00` ); }
    if (/^\d{6}$/.test(value)) { return ( `${value.slice(0, 2)}:` + `${value.slice(2, 4)}:` + `${value.slice(4, 6)}` ); }
    return value;
}

function syncMachineSubscriptions(targetMachines) {
    const target = new Set(targetMachines);
    const subscribe = [...target].filter( machine => !subscribedMachines.has(machine) );
    const unsubscribe = [...subscribedMachines].filter( machine => !target.has(machine) );

    if (subscribe.length > 0) { socket.emit("subscribe_machines", { machine_ids: subscribe }); }
    if (unsubscribe.length > 0) { socket.emit("unsubscribe_machines", { machine_ids: unsubscribe }); }
    subscribedMachines = target;
}


function getTodayDate(){
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth()+1).padStart(2,"0");
    const day = String(now.getDate()).padStart(2,"0");
    return `${year}-${month}-${day}`;
}

function resetMachineHistory(machineIds = selectedMachines ) {
    machineIds.forEach(machineId => {
        const history = machineHistory[machineId];
        if (!history) return;
        history.labels.length = 0;
        history.power.length = 0;
        history.voltage.length = 0;
        history.seal_power.length = 0;
        history.seal_voltage.length = 0;
        history.bags.length = 0;
        history.timeline.length = 0;
        if (history.labelIndex instanceof Map) { history.labelIndex.clear(); } 
        else { history.labelIndex = new Map(); }
        history.currentStatus = null;
    });
}

function requestSnapshot(machineIds, date) {
    const machines = Array.isArray(machineIds) ? machineIds : [machineIds];

    // 每次要求 snapshot，都產生新的 request ID
    snapshotRequestId += 1;
    const requestId = snapshotRequestId;
    machines.forEach(machine => {
        pendingSnapshots.set(machine, requestId);
        realtimeBuffers.set(machine, {requestId: requestId, data: [] });
    });
    socket.emit("request_data", { machine_id: machines, date: date, request_id: requestId });
}

function parseTime(str){
    const [h,m,_] = str.split(":");
    return Number(h) * 60 + Number(m);;
}

function getSelectedDate() {
    if (!currentYear || !currentMonth || !currentDate) { return null; }
    return `${currentYear}-${currentMonth}-${currentDate}`;
}

function requestMachineData() {
    resetMachineHistory();
    const date = getSelectedDate();
    requestSnapshot(selectedMachines, date);
}
function addOption(select, value, text = value) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    select.appendChild(option);
}
function updateYearSelect() {
    yearSelect.innerHTML = "";
    const years = [ ...new Set(availableDates.map(date => date.slice(0, 4)) ) ].sort((a, b) => b - a);
    years.forEach(year => { addOption(yearSelect, year); });
    if (years.includes(currentYear)) { yearSelect.value = currentYear; } 
    else { currentYear = years[0] || null; yearSelect.value = currentYear; }
}
function updateMonthSelect() {
    monthSelect.innerHTML = "";

    if (!currentYear) {
        currentMonth = null;
        return;
    }
    const months = [ ...new Set( availableDates .filter(date => date.slice(0, 4) === currentYear) .map(date => date.slice(5, 7)) ) ].sort();

    months.forEach(month => { addOption(monthSelect, month); });
    if (months.includes(currentMonth)) { monthSelect.value = currentMonth; } 
    else { currentMonth = months[0] || null; monthSelect.value = currentMonth; }
}
function updateDateSelect() {
    dateSelect.innerHTML = "";

    if (!currentYear || !currentMonth) {
        currentDate = null;
        return;
    }
    const days = [
        ...new Set(
            availableDates
                .filter(date => date.slice(0, 4) === currentYear && date.slice(5, 7) === currentMonth )
                .map(date => date.slice(8, 10))
        )
    ].sort();

    days.forEach(day => { addOption(dateSelect, day); });
    if (days.includes(currentDate)) { dateSelect.value = currentDate; } 
    else { currentDate = days[0] || null; dateSelect.value = currentDate; }
}
yearSelect.addEventListener("change", function () { currentYear = this.value; updateMonthSelect(); updateDateSelect(); requestMachineData(); });
monthSelect.addEventListener("change", function () { currentMonth = this.value; updateDateSelect(); requestMachineData(); });
dateSelect.addEventListener("change", function () { currentDate = this.value; requestMachineData(); });

function destroyDisplayCharts() {
    Object.values(displayCharts).forEach(chart => { if (chart) { chart.destroy(); } });
    Object.keys(displayCharts).forEach(key => { delete displayCharts[key]; });
}

function addDashboard(machineId) {
    const selectedDate = getSelectedDate();
    const area = document.querySelector(".dashboard-area");
    if (dashboards[machineId]) return;
    createDashboard(machineId);
    if (selectedDate) { requestSnapshot(machineId, selectedDate); }

    selectedMachines.forEach(machineId => {
        const dashboard = dashboards[machineId];
        if (dashboard) { area.appendChild(dashboard.root); }
    });
}

function removeDashboard(machineId) {
    const dashboard = dashboards[machineId];
    if (!dashboard) return;
    dashboard.powerChart.destroy();
    dashboard.utilizationChart.destroy();
    dashboard.root.remove();
    delete dashboards[machineId];
    pendingSnapshots.delete(machineId);
    realtimeBuffers.delete(machineId);
}

function createCell(id) {
    const template = document.getElementById("cell-template");
    const fragment = template.content.cloneNode(true);

    const table = fragment.querySelector(".cell");
    const header = fragment.querySelector(".cellheader");
    const lamp = fragment.querySelector(".status-lamp");
    const machineName = fragment.querySelector(".cellhead");
    
    table.dataset.machine = id;
    header.dataset.machine = id;
    lamp.id = `${id}-lamp`;
    machineName.textContent = id;
    header.addEventListener("click", function () { selectedMachines[0] = this.dataset.machine; document.querySelector("#reset").click(); });
    
    requestSnapshot( id, getTodayDate() );
    return table;
}

function renderDisplayCells() {
    destroyDisplayCharts();
    const cellboard = document.querySelector(".cellboard");
    cellboard.replaceChildren();
    const line1 = document.createElement("div");
    line1.className = "cellline1";
    const line2 = document.createElement("div");
    line2.className = "cellline";

    Object.keys(machineHistory).forEach(id => {
        const table = createCell(id);
        if (id.startsWith("S-") && id[id.length-1]<"K") { line1.appendChild(table); } //id[id.length-1]<"K"
        else { line2.appendChild(table); }
    });
    cellboard.append(line1, line2);
    document.querySelectorAll(".cell").forEach(table => {
        const id = table.dataset.machine;
        const canvas = table.querySelector(".utilizationCanvas");

        const utilizationChart = createUtilizationChart(canvas);
        displayCharts[id] = utilizationChart;
    });
    
}


function dateswitch(Switch)
{
    yearSelect.disabled = Switch;
    monthSelect.disabled =Switch;
    dateSelect.disabled = Switch;  
}

document
.querySelector("#reset")
.addEventListener("click", function(){
    document.querySelector(".toolbar").style.pointerEvents = "";
    dateswitch(false);
    document.querySelector("#multi").style.color = "#3f3f3f";
    multiple = false;
    document.querySelector("#display").style.color = "#3f3f3f";
    if (display){selectedMachines = [selectedMachines[0]];}
    else {selectedMachines[0] = machinehead;}
    Object.values(dashboards).forEach(dashboard => {
        dashboard.powerChart.destroy();
        dashboard.utilizationChart.destroy();
    });
    destroyDisplayCharts()
    Object.keys(machineHistory).forEach(key => { delete machineHistory[key]; });
    Object.keys(dashboards).forEach(key => { delete dashboards[key]; });
    document.querySelector(".dashboard-area").innerHTML = "";
    document.querySelectorAll('.cellboard').forEach(el => { el.replaceChildren(); });
    socket.emit("request_init");
});

function getDisplayMachines() { return Object.keys(machineHistory) }

document
    .querySelector("#display")
    .addEventListener("click", function () {
        this.style.color = "#ffffff";
        const today = getTodayDate();
        currentYear = today.slice(0, 4);
        currentMonth = today.slice(5, 7);
        currentDate = today.slice(8, 10);
        yearSelect.value = currentYear;
        monthSelect.value = currentMonth;
        dateSelect.value = currentDate;
        document.querySelector(".toolbar").style.pointerEvents = "none";
        dateswitch(true);
        if (display) { return; }
        display = true;
        syncMachineSubscriptions(getDisplayMachines());
        renderDisplayCells();
        document .querySelectorAll(".toolbar, .dashboard-area") .forEach(element => { element.replaceChildren(); });
});

document
.querySelector("#multi")
.addEventListener("click", function(){
    if (multiple){
        multiple = false;
        this.style.color = "#3f3f3f";
        selectedMachines = [selectedMachines[0]]
        document.querySelectorAll(".toolbar .machine-selected") .forEach(el => el.classList.remove("machine-selected"));
        document.getElementById(selectedMachines[0]).classList.add("machine-selected");
        renderDashboards();}
    else{
        multiple = true;
        this.style.color = "#ffffff";}
    
});

document
.querySelector(".toolbar")
.addEventListener("click", function (e) {
    const button = e.target.closest("button");
    if (!button) return;
    const machine = button.id;
    if (multiple) {
        const isSelected = button.classList.toggle("machine-selected");
        if (isSelected) {
            selectedMachines.push(machine);
            selectedMachines.sort(compareMachines);
            addDashboard(machine);
        } else { 
            selectedMachines = selectedMachines.filter(id => id !== machine);
            removeDashboard(machine);}
    } else {
        if (selectedMachines[0] === machine) { return; }
        document .getElementById(selectedMachines[0]) ?.classList.remove("machine-selected");
        removeDashboard(selectedMachines[0]);
        selectedMachines[0] = machine;
        button.classList.add("machine-selected");
        addDashboard(machine);}
    syncMachineSubscriptions(selectedMachines);
});

socket.on("connect", function(){
    console.log("socket connected");
    subscribedMachines = new Set();
    socket.emit("request_init");
});

// socket.on("IOT", function(){
//     socket.emit( "request_data", { machine_id:selectedMachines, date:getSelectedDate() } );
// })

function createDashboard(machineId){

    const template = document.getElementById( "dashboard-template" );
    const clone = template.content.cloneNode(true);
    const div = document.createElement("div");
    div.className="machine-dashboard";
    div.dataset.machine=machineId;
    div.appendChild(clone);
    document
    .querySelector(".dashboard-area")
    .appendChild(div);

    const powerCanvas = div.querySelector(".powerCanvas");
    const utilizationCanvas = div.querySelector(".utilizationCanvas");
    const timelineCanvas = div.querySelector(".timelineCanvas");
    dashboards[machineId] = {
        root: div,
        powerChart: createPowerChart(powerCanvas),
        utilizationChart: createUtilizationChart(utilizationCanvas),
        timelineCanvas: timelineCanvas
    };

    if (!machineId.startsWith("S-")) {
        div.querySelector(".sw")?.remove();
        div.querySelector(".sv")?.remove();

        dashboards[machineId].powerChart.data.datasets[3].hidden = true;
        dashboards[machineId].powerChart.data.datasets[3].label = "";
        dashboards[machineId].powerChart.data.datasets[4].hidden = true;
        dashboards[machineId].powerChart.data.datasets[4].label = "";
    }
    setupTimelineHover(machineId);
}

function renderDashboards() {
    const area = document.querySelector(".dashboard-area");

    Object.values(dashboards).forEach(d => { d.powerChart.destroy(); d.utilizationChart.destroy(); });
    Object.keys(dashboards).forEach(key => { delete dashboards[key]; });
    area.innerHTML = "";
    resetMachineHistory();
    syncMachineSubscriptions(selectedMachines);
    selectedMachines.forEach(machine => { createDashboard(machine); });
    requestSnapshot( selectedMachines, getSelectedDate() );
}

socket.on("init_toolbar", function(data) {
    const machine = display ? selectedMachines[0] : data.statuses[0].id;
    machinehead = data.statuses[0].id
    display = false
    const toolbar = document.querySelector(".toolbar");
    toolbar.innerHTML = "";
    const order = ["S", "PG"];
    const groups = {};

    order.forEach(typeName => {
        const type = document.createElement("div");
        groups[typeName] = type;
        toolbar.appendChild(type);
    });

    data.statuses.forEach(item => {
        const machine = item.id;
        const status = item.s;
        let typeName;

        if (machine.startsWith("PG-")) { typeName = "PG"; } 
        else if (machine.startsWith("S-")) { typeName = "S"; }

        const button = document.createElement("button");
        button.id = machine;
        const lamp = document.createElement("span");
        lamp.id = `${machine}-lamp`;
        lamp.classList.add("status-lamp");
        updateLampClass(lamp, status)
        
        const text = document.createElement("span");
        text.textContent = machine;
        button.appendChild(lamp);
        button.appendChild(text);

        // P / PG / PP 不同 class
        if (machine.startsWith("S-")){button.classList.add("btn-small");}
        if (machine.startsWith("PG-")){button.classList.add("btn-giant");}

        groups[typeName].appendChild(button);

        machineHistory[machine] = {
            labels: [],
            power: [],
            voltage: [],
            seal_power: [],
            seal_voltage: [],
            bags: [],
            labelIndex: new Map(),
            timeline: [],
            currentStatus: null,
            utilization: 0
        };
    });
    if (machine) {
        selectedMachines = [ machine ];   // 第一台機器
        const firstButton = document.getElementById(machine);
        if(firstButton){ firstButton.classList.add("machine-selected"); }
        renderDashboards();
    }
});

socket.on("init_date", function (data) {
    availableDates = data.dates.map(d =>
        `20${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4, 6)}`
    );
    availableDates.sort((a, b) => b.localeCompare(a));
    const today = getTodayDate();
    if (availableDates.includes(today)) {
        currentYear = today.slice(0, 4);
        currentMonth = today.slice(5, 7);
        currentDate = today.slice(8, 10);
    } else {
        const latestDate = availableDates[0];
        currentYear = latestDate.slice(0, 4);
        currentMonth = latestDate.slice(5, 7);
        currentDate = latestDate.slice(8, 10);
    }
    updateYearSelect();
    updateMonthSelect();
    updateDateSelect();
    yearSelect.value = currentYear;
    monthSelect.value = currentMonth;
    dateSelect.value = currentDate;
    socket.emit("lamp_date");
});

socket.on("lamp_updated", function(data){
    data.statuses.forEach(item => {
        const lamp = document.getElementById( `${item.id}-lamp` );
        if(lamp){ updateLampClass( lamp, item.s ); }
    });
});


socket.on("machine_updated", function(data){
    const output = data.output;
    const power = data.power;
    const status_history = Array.isArray(data.history) ? data.history : [];

    if (!output || !output.id) {
    console.warn( "machine_updated 沒有有效 output", data );
    return;
    }
    
    const machine = output.id;
    const history = machineHistory[machine];
    if((data.realtime && getSelectedDate() !== getTodayDate()) || (!display && !selectedMachines.includes(machine)) || !history) return;
    if ( !display && data.realtime && pendingSnapshots.has(machine) ) {
        const buffer = realtimeBuffers.get(machine);
        if (buffer) { buffer.data.push(data); }
        return;
    }
    if(display) {
        const table = document.querySelector( `.cell[data-machine="${machine}"]` );
        const lamp = document.querySelector( `#${machine}-lamp` );
        if (!table) {return; }
        const statusEl = table.querySelector('[data-key="status"]');
        statusEl.textContent = output.s;
        applyStatusClass(statusEl, output.s);
        table.querySelector('[data-key="production"]').textContent = output.b;
        table.querySelector('[data-key="speed"]').textContent = output.bps;
        table.querySelector('[data-key="interrupt"]').textContent = output.its;
        updateUtilizationChart(output)
        updateLampClass(lamp, output.s[0])
        return;
    }
    /* 1. 更新 Dashboard */
    updateUI(machine, output);

    /*2. 更新 Power Chart */
    power.l = power.l.map( item => `${item.slice(0,2)}:${item.slice(2,4)}:00` );
    history.currentStatus = output.s[0];
    if (!data.realtime) {
        const expectedRequestId = pendingSnapshots.get(machine);
        if (expectedRequestId === undefined || data.request_id !== expectedRequestId || data.date !== getSelectedDate())  { return; }
        // 先把 snapshot 當成基礎資料
        history.labels = [...power.l];
        history.power = [...power.w];
        history.voltage = [...power.v]
        history.seal_power = [...power.sw];
        history.seal_voltage = [...power.sv];
        history.bags = [...power.c];

        // snapshot 已經完成
        pendingSnapshots.delete(machine);

        // 取出 snapshot 載入期間收到的 realtime data
        const buffer = realtimeBuffers.get(machine);
        const bufferedRealtime = buffer?.requestId === data.request_id ? buffer.data : [];

        // 依抵達順序合併，upsertRealtimePower 會負責去重及排序
        bufferedRealtime.forEach(realtimeData => {
            // 合併功率、電壓與產量
            upsertRealtimePower( history, realtimeData.power );
            // 合併 realtime 期間發生的狀態變化
            if (Array.isArray(realtimeData.history)) { status_history.push(...realtimeData.history); }
        });

        // 使用最後一筆 realtime 更新畫面上的即時數值
        const latestRealtime = bufferedRealtime[bufferedRealtime.length - 1];

        if (latestRealtime?.output) {
            history.currentStatus = latestRealtime.output.s?.[0] ?? history.currentStatus;
            updateUI(machine, latestRealtime.output);
        }

        // 合併完成後清除 buffer
        realtimeBuffers.delete(machine);
    }
    else { upsertRealtimePower(history, power); }
    renderPowerChart(machine);

    /*3. 建立時間軸*/
    const milestone = (getSelectedDate() !== getTodayDate()) ?  1290 : getCurrentMinute();//
    // if (status_history.length > 1 && getSelectedDate() !== getTodayDate()) {
    for (let i = 0; i < status_history.length; i++) {
        const current = status_history[i];
        const next = status_history[i + 1];
        const start = parseTime(`${current.t.slice(0, 2)}:${current.t.slice(2, 4)}:00`);
        const end = next
            ? parseTime(`${next.t.slice(0, 2)}:${next.t.slice(2, 4)}:00`)
            : milestone;
        if (milestone >= end) {
            const existingIndex = history.timeline.findIndex(segment => { return segment.start === start; });
            const newSegment = { status: current.s, start: start, end: end };
            // 相同開始時間已存在，使用新資料覆蓋
            if (existingIndex !== -1) { history.timeline[existingIndex] = newSegment; } 
            // 新的狀態時間才加入
            else { history.timeline.push(newSegment); }
        }}
    history.timeline.sort((a, b) => { return a.start - b.start; });
    drawTimeline(machine);
});

function getCurrentMinute(){
    const now=new Date();
    return now.getHours()*60+now.getMinutes();
}

// 更新 UI
function updateUI(machine, output) {
    // 找該機台 dashboard
    const dashboard =
    dashboards[machine];
    // 如果 dashboard 不存在，不更新
    if(!dashboard) return;
    const root =
    dashboard.root;
    // ===== 區塊 A：即時狀態 =====
    const statusEl = root.querySelector(".statusE1");
    statusEl.textContent = output.s;
    applyStatusClass(statusEl, output.s);
    root.querySelector(".w").innerHTML = `當前功率：<strong>${output.w.toFixed(2)}</strong> W`;
    root.querySelector(".v").innerHTML = `當前電壓：<strong>${output.v.toFixed(2)}</strong> V`;
    root.querySelector(".i").innerHTML = `中斷警示：<strong>${output.i.toFixed(2)}</strong> min`;
    const swEl = root.querySelector(".sw");
    const svEl = root.querySelector(".sv");
    if (swEl) { swEl.innerHTML = `封口功率：<strong>${output.sw.toFixed(2)}</strong> W`; }
    if (svEl) { svEl.innerHTML = `封口電壓：<strong>${output.sv.toFixed(2)}</strong> V`; }
    // ===== 區塊 B：今日生產 =====
    root.querySelector(".b").innerHTML = `今日總產量：<strong>${output.b}</strong> 袋`;
    root.querySelector(".bps").innerHTML = `平均速度：<strong>${output.bps.toFixed(2)}</strong> 袋/sec`;
    root.querySelector(".its").innerHTML = `今日中斷次數：<strong>${output.its}</strong> 次`;
    root.querySelector(".it").innerHTML = `累積中斷時間：<strong>${output.it}</strong> min`;

    // ===== 區塊 C：能源 =====
    root.querySelector(".kwh").innerHTML = `今日總用電：<strong>${output.kwh.toFixed(2)}</strong> kWh`;
    root.querySelector(".u").innerHTML = `設備稼動率：<strong>${output.u.toFixed(2)}</strong> %`;
    root.querySelector(".wpb").innerHTML = `每袋能耗：<strong>${output.wpb.toFixed(2)}</strong> W/袋`;
    updateUtilizationChart(output);
}

// 顯示錯誤信息
function showError(message) {
    const errorContainer = document.getElementById("error-message");
    const errorElement = document.createElement("div");

    errorElement.className = "error";
    errorElement.textContent = message;

    errorContainer.replaceChildren(errorElement);
}

function clearError() {
    document.getElementById("error-message").replaceChildren();
}

function timelineconst(machine)
{
    const dashboard = dashboards[machine];
    if(!dashboard) return;
    const canvas = dashboard.timelineCanvas;
    if(!canvas) return;

    const tctx = canvas.getContext("2d");
    const timeline = machineHistory[machine].timeline;
    // ====== 座標 ======
    const left = 20;
    const top = 40;
    const width = canvas.clientWidth - 80;
    const height = 30;
    const hoverHeight = 10;
    // ====== 顯示時間範圍 ======
    const totalMinute = endMinute - startMinute; //720分鐘
    return {
        dashboard,
        canvas,
        tctx,
        timeline,
        left,
        top,
        width,
        height,
        hoverHeight,
        totalMinute
    };

}

function drawTimeline(machine){
    const dashboard = dashboards[machine];
    if (!dashboard) return;

    if (!dashboard.timelineInitialized || timelineHoverIndex != -1) {
        Timelineint(machine);
        dashboard.timelineInitialized = true;
    }
    Timelineupdate(machine);
}

function Timelineint(machine){
    const ctx = timelineconst(machine);
    if (!ctx) return;
    const {
        canvas,
        tctx,
        timeline,
        left,
        top,
        width,
        height,
        hoverHeight,
        totalMinute
    } = ctx;
    canvas.width = canvas.clientWidth;
    tctx.clearRect( 0, 0, canvas.width, canvas.height );
    // ====== 時間軸 ======
    tctx.strokeStyle = "white";
    tctx.beginPath();
    tctx.moveTo(left, top+height/2);
    tctx.lineTo(left+width, top+height/2);
    tctx.stroke();

    // ====== 每5分鐘一格 ======
    for(let m=startMinute; m<=endMinute; m+=5){
        let x = left + ((m-startMinute)/totalMinute)*width;
        let minute = m % 60;
        let tickLength = 8;
        if(minute === 0){ tickLength = 26; }
        else if(minute === 30){ tickLength = 23; }
        else {tickLength = 20;}
        tctx.beginPath();
        tctx.moveTo( x, top+height/2-tickLength );
        tctx.lineTo( x, top+height/2+tickLength );
        tctx.stroke();

        // 每30分鐘顯示文字，避免太密
        if((m-startMinute)%30===0){
            let hour = Math.floor(m/60);
            let minute = m%60;
            tctx.fillStyle="white";
            tctx.font="12px Arial";
            tctx.fillText( hour.toString().padStart(2,"0") +":" +minute.toString().padStart(2,"0"), x-18, 90 );
        }
    }
    // 左邊標籤
    tctx.fillStyle="white";
    tctx.font="20px Arial";
    let adjust = tctx.measureText(machine).width < 50 ? 7 : 0
    tctx.fillText( machine,canvas.width - tctx.measureText(machine).width-adjust, 50 );
}

function Timelineupdate(machine){
    const ctx = timelineconst(machine);
    if (!ctx) return;
    const {
        tctx,
        timeline,
        left,
        top,
        width,
        height,
        hoverHeight,
        totalMinute
    } = ctx;
    timeline.forEach((seg,index)=>{
        let s = seg.start;
        let e = seg.end;
        if (index === timeline.length - 1 && getSelectedDate() === getTodayDate()) { e = getCurrentMinute(); }
        if(e < startMinute || s > endMinute){ return; }
        s = Math.max(s,startMinute);
        e = Math.min(e,endMinute);

        let x1 = left + ((s-startMinute)/totalMinute)*width;
        let x2 = left + ((e-startMinute)/totalMinute)*width;
        const color = STATUS_CONFIG[normalizeStatus(seg.status)].color;
        // tctx.fillStyle=color;
        // tctx.fillRect( x1, top, Math.max(2,x2-x1), height );
        const isHover = index === timelineHoverIndex;
        // Hover 的 segment 變大
        const drawHeight = isHover ? hoverHeight*2+height : height;
        // 往上長，底部維持在原本的位置
        const drawTop = isHover ? top-hoverHeight : top ;
        tctx.fillStyle = color;
        tctx.fillRect( x1, drawTop, Math.max(2, x2 - x1), drawHeight );
        tctx.fillStyle = "white";
        // Hover 時加一個白色外框，讓效果更明顯
        if(isHover && e-s >5){
            tctx.strokeStyle = "white";
            tctx.lineWidth = 2;
            tctx.strokeRect( x1, drawTop, Math.max(2, x2 - x1), drawHeight );
            tctx.lineWidth = 1;
        }
    });
}

function setupTimelineHover(machine){
    const ctx = timelineconst(machine);
    if (!ctx) return;
    const {
        canvas,
        tctx,
        left,
        top,
        width,
        height,
        totalMinute
    } = ctx;
    canvas.addEventListener("mousemove", function(e){
    const timeline = machineHistory[machine]?.timeline || [];
    const rect = canvas.getBoundingClientRect();
    const mouseX = (e.clientX - rect.left) * (canvas.width / rect.width); 
    const mouseY = (e.clientY - rect.top) * (canvas.height / rect.height);
    const mouseMinute = startMinute + (mouseX - left) / width * totalMinute;
    const hour = Math.floor(mouseMinute / 60);
    const minute = Math.floor(mouseMinute % 60);
    const timeText = String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0");
    let hoverIndex = -1;
        if(
            mouseX >= left &&
            mouseX <= left + width
        &&
            mouseY >= top &&
            mouseY <= top + height
        ){
        if (timelineHoverIndex != -1)drawTimeline(machine);
        tctx.clearRect(canvas.width - 55, 50 , 70, 30 );
        tctx.fillText(timeText,canvas.width - tctx.measureText(timeText).width -5, 70 );
        const mouseMinute = startMinute + ((mouseX - left) / width) * totalMinute;
        timeline.forEach((seg, index) => { if( mouseMinute >= seg.start && mouseMinute <= seg.end ){ hoverIndex = index; } });
        if (hoverIndex != -1){
            let listtime = timeline[hoverIndex].end-timeline[hoverIndex].start
            listtime =  String( Math.floor(listtime / 60)).padStart(2, "0") + ":" + String(Math.floor(listtime % 60)).padStart(2, "0");
            const statusCode = timeline[hoverIndex].status;
            const liststatus = STATUS_CONFIG[statusCode]?.name ?? "Unknown";
            let listline = listtime + " " +liststatus
            let listinfo = machine+" "+timeText
            tctx.fillText(listline,mouseX-tctx.measureText(listline).width/2, mouseY-20);
            tctx.fillText(listinfo,mouseX-tctx.measureText(listline).width*0.45, mouseY+40);
        }}
        if(hoverIndex !== timelineHoverIndex){
            timelineHoverIndex = hoverIndex;
            drawTimeline(machine);
        }
        if(timelineHoverIndex == -1){
        Timelineint(machine);
        Timelineupdate(machine);
        }
    });
    
}


function renderPowerChart(machine){
    if(!dashboards[machine])return;
    const history = machineHistory[machine];
    const chart = dashboards[machine].powerChart;
    const labels=[];
    const power=[];
    const voltage=[];
    const seal_power=[];
    const seal_voltage=[];
    const bags=[];
    let bag = 0;
    for(let i=0;i<history.labels.length;i++){
        bag+=history.bags[i]
        if(
            history.labels[i].endsWith(":00:00")  ||
            (history.bags[i] == 0 && history.bags[i-1] != history.bags[i]) || 
            (history.power[i] == 0 && history.power[i - 1] != 0))
        {
            labels.push(history.labels[i]);
            power.push(history.power[i]);
            voltage.push(history.voltage[i]);
            seal_power.push( history.seal_power[i] !== -1 ? history.seal_power[i] : null );
            seal_voltage.push( history.seal_voltage[i] !== -1 ? history.seal_voltage[i] : null );
            bags.push(bag);
            bag = 0;
        }
    }
    chart.data.labels=labels;
    chart.data.datasets[0].data=power;
    chart.data.datasets[1].data=voltage;
    chart.data.datasets[2].data=bags;
    chart.data.datasets[3].data=seal_power;
    chart.data.datasets[4].data=seal_voltage;
    chart.data.datasets[3].hidden = !machine.startsWith("S-");
    chart.data.datasets[4].hidden = !machine.startsWith("S-");
    chart.update();
}


function updateUtilizationChart(output){
    let chart;
    if (display) { chart = displayCharts[output.id]; } 
    else { chart = dashboards[output.id]?.utilizationChart; }
    if(!chart) return;
    chart.data.datasets[0].data=[ output.u, 100-output.u ];
    chart.update();
}




