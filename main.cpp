#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>

const char* WIFI_SSID = "SC-Unifi";
const char* WIFI_PASS = "SC88700083";
const char* SERVER_BASE_URL = "http://192.168.100.96:7200";
const char* SIGNAL_API = "http://192.168.100.96:7200/api/iot/signal";
// Device
const char* DEVICE_ID = "S-A";
const int COUNTER_PIN = 15;
const int RED_PIN     = 16;
const int YELLOW_PIN  = 17;
const int GREEN_PIN   = 18;
int redState = 0;
int yellowState = 0;
int greenState = 0;
int lastRedState = -1;
int lastYellowState = -1;
int lastGreenState = -1;
int rawRedState = HIGH;
int rawYellowState = HIGH;
int rawGreenState = HIGH;

const uint32_t DEFAULT_COUNTER_HIGH_V = 2500;
const uint32_t DEFAULT_COUNTER_LOW_V  = 500;
const unsigned long DEFAULT_COUNTER_HIGH_STABLE_US  = 20000;
const unsigned long DEFAULT_COUNTER_LOW_STABLE_US  = 20000;
const unsigned long DEFAULT_COUNTER_DEBOUNCE_US  = 50000;
const unsigned long COUNTER_CONFIG_NVS_TIMEOUT_MS = 10000;
const unsigned long NTP_SYNC_TIMEOUT_MS = 5000;
uint32_t counterHighMv = DEFAULT_COUNTER_HIGH_V;
uint32_t counterLowMv = DEFAULT_COUNTER_LOW_V;
unsigned long counterHighStableUs = DEFAULT_COUNTER_HIGH_STABLE_US;
unsigned long counterLowStableUs = DEFAULT_COUNTER_LOW_STABLE_US;
unsigned long counterDebounceUs = DEFAULT_COUNTER_DEBOUNCE_US;
unsigned long lastReadTime = 0;
unsigned long lastSendTime = 0;
unsigned long lastNtpCheck = 0;
unsigned long lastNtpAttempt = 0;
const uint16_t HTTP_CONNECT_TIMEOUT_MS = 1000;
const uint16_t HTTP_TIMEOUT_MS = 1500;
const unsigned long SEND_INTERVAL_MS = 1000;
const unsigned long WIFI_RETRY_MS = 10000;
const unsigned long READ_INTERVAL_MS = 50;
unsigned long counterValue = 0;
unsigned long lastWifiTry = 0;
unsigned long bootInitializationStartedMs = 0;
const char* NTP_SERVER_1 = "pool.ntp.org";
const char* NTP_SERVER_2 = "time.google.com";
const long GMT_OFFSET_SEC = 8 * 3600;
const int DAYLIGHT_OFFSET_SEC = 0;
const bool DEBUG_LOG = true;
const bool SIGNAL_ACTIVE_HIGH = false;
bool countingEnabled = false;
bool lastCountingEnabled = false;
bool counterResyncAckPending = false;
bool timeSynced = false;
bool counterConfigReady = false;
bool lastServerPostOk = false;
TaskHandle_t counterTaskHandle = nullptr;
portMUX_TYPE counterMux = portMUX_INITIALIZER_UNLOCKED;
volatile unsigned long lastPulseMicros = 0;
volatile unsigned long PulseCount = 0;
volatile bool CounterHigh = true;
volatile uint32_t latestCounterMilliVolts = 0;
unsigned long lastHandledPulseCount = 0;
String getStatusText() {
  // 優先順序：紅 > 黃 > 綠
  if (redState == 1) { return "STOP"; }
  if (yellowState == 1) { return "IDLE"; }
  if (greenState == 1) { return "RUNNING"; }
  return "BREAK";
}

void debugPrintln(const String& msg) { if (DEBUG_LOG) { Serial.println(msg); } }
void debugPrint(const String& msg) { if (DEBUG_LOG) { Serial.print(msg); } }

const char* getRawLevelText(int rawValue) { return rawValue == HIGH ? "HIGH" : "LOW"; }
const char* getContactText(int state) { return state == 1 ? "CLOSED" : "OPEN"; }
const char* getOnOffText(int state) { return state == 1 ? "ON" : "OFF"; }

bool parseCounterValue(String value, unsigned long& outputValue) {
  value.trim();
  if (value.length() == 0) { return false; }
  for (unsigned int i = 0; i < value.length(); i++) {
    if (!isDigit(value[i])) { return false; }
  }
  outputValue = strtoul(value.c_str(), nullptr, 10);
  return true;
}

String getJsonValue(String json, String key) {
  String target = "\"" + key + "\":";
  int start = json.indexOf(target);
  if (start < 0) { return ""; }
  start += target.length();
  while ( start < json.length() && 
        ( json[start] == ' ' || json[start] == '"' ) ) {
    start++;
  }

  int end = start;

  while (end < json.length()) {
    char c = json[end];
    if ( c == ',' || c == '}' || c == '"' ) { break; }
    end++;
  }

  return json.substring(start, end);
}


bool getJsonBool(String value) {
  value.trim();
  value.toLowerCase();
  return value == "true" || value == "1";
}

void counterTask(void* parameter) {
  
  bool highCandidateActive = false;
  bool lowCandidateActive = false;
  unsigned long highCandidateSinceUs = 0;
  unsigned long lowCandidateSinceUs = 0;
  while (true) {
      uint32_t initialMv = analogReadMilliVolts(COUNTER_PIN);
      portENTER_CRITICAL(&counterMux);
      latestCounterMilliVolts = initialMv;
      CounterHigh = initialMv >= counterHighMv;
      portEXIT_CRITICAL(&counterMux);
      uint32_t milliVolts = initialMv;
      unsigned long nowUs = micros();
      portENTER_CRITICAL(&counterMux);
      latestCounterMilliVolts = milliVolts;
      bool countPulseAccepted = false;

      if (!counterConfigReady) {
        highCandidateActive = false;
        lowCandidateActive = false;
        countPulseAccepted = false; } 
      else if (CounterHigh) {
        if (milliVolts <= counterLowMv) {
          if (!lowCandidateActive) {
            lowCandidateActive = true;
            lowCandidateSinceUs = nowUs;
          }

          if (
            (unsigned long)(nowUs - lowCandidateSinceUs) >= counterLowStableUs &&
            (unsigned long)(nowUs - lastPulseMicros) >= counterDebounceUs
          ) {
            PulseCount++;
            lastPulseMicros = nowUs;
            countPulseAccepted = true;
            CounterHigh = false;
            lowCandidateActive = false;
          }} 
        else { lowCandidateActive = false; } } 
      else {
        if (milliVolts >= counterHighMv) {
          if (!highCandidateActive) {
            highCandidateActive = true;
            highCandidateSinceUs = nowUs; }
          if ((unsigned long)(nowUs - highCandidateSinceUs) >= counterHighStableUs) {
            CounterHigh = true;
            highCandidateActive = false; } } 
        else { highCandidateActive = false; } }
      portEXIT_CRITICAL(&counterMux);
      vTaskDelay(pdMS_TO_TICKS(2));
  }
}
int normalizeInput(int rawValue) {
  if (SIGNAL_ACTIVE_HIGH) {
    return rawValue == HIGH ? 1 : 0;
  }

  // 乾接點版本：
  // LOW = 接點短路 = 有效
  return rawValue == LOW ? 1 : 0;
}
void printSignalLog() {
  if (!DEBUG_LOG) {
    return;
  }

  Serial.println();
  Serial.println("========== GPIO SIGNAL LOG ==========");

  Serial.printf(
    "RED    GPIO%-2d Raw=%d (%s) State=%d (%s) Contact=%s\n",
    RED_PIN,
    rawRedState,
    getRawLevelText(rawRedState),
    redState,
    getOnOffText(redState),
    getContactText(redState)
  );

  Serial.printf(
    "YELLOW GPIO%-2d Raw=%d (%s) State=%d (%s) Contact=%s\n",
    YELLOW_PIN,
    rawYellowState,
    getRawLevelText(rawYellowState),
    yellowState,
    getOnOffText(yellowState),
    getContactText(yellowState)
  );

  Serial.printf(
    "GREEN  GPIO%-2d Raw=%d (%s) State=%d (%s) Contact=%s\n",
    GREEN_PIN,
    rawGreenState,
    getRawLevelText(rawGreenState),
    greenState,
    getOnOffText(greenState),
    getContactText(greenState)
  );

  Serial.printf(
    "Counting: %s\n",
    countingEnabled ? "START" : "STOP"
  );

  Serial.println("=====================================");
}
void readSignals() {
  // 讀取 GPIO 原始電位
  rawRedState = digitalRead(RED_PIN);
  rawYellowState = digitalRead(YELLOW_PIN);
  rawGreenState = digitalRead(GREEN_PIN);

  // 轉換成有效狀態
  redState = normalizeInput(rawRedState);
  yellowState = normalizeInput(rawYellowState);
  greenState = normalizeInput(rawGreenState);

  // 只有單獨綠燈有效時允許計數
  countingEnabled = (
    greenState == 1 &&
    yellowState == 0 &&
    redState == 0
  );

  // 狀態變化時印 LOG
  if (
    redState != lastRedState ||
    yellowState != lastYellowState ||
    greenState != lastGreenState ||
    countingEnabled != lastCountingEnabled
  ) {
    printSignalLog();

    lastRedState = redState;
    lastYellowState = yellowState;
    lastGreenState = greenState;
    lastCountingEnabled = countingEnabled;
  }
}

bool syncTime() {
  if (WiFi.status() != WL_CONNECTED) {
    return false;
  }

  debugPrintln("");
  debugPrintln("Syncing NTP...");
  lastNtpAttempt = millis();

  configTime(
    GMT_OFFSET_SEC,
    DAYLIGHT_OFFSET_SEC,
    NTP_SERVER_1,
    NTP_SERVER_2
  );

  struct tm timeinfo;
  unsigned long start = millis();

  while (
    !getLocalTime(&timeinfo, 100) &&
    millis() - start < NTP_SYNC_TIMEOUT_MS
  ) {
    debugPrint(".");
    delay(500);
  }

  debugPrintln("");

  if (getLocalTime(&timeinfo, 100)) {
    timeSynced = true;
    lastNtpCheck = millis();

    char buf[40];

    strftime(
      buf,
      sizeof(buf),
      "%Y-%m-%dT%H:%M:%S+08:00",
      &timeinfo
    );

    debugPrint("NTP Synced: ");
    debugPrintln(String(buf));

    return true;
  }

  timeSynced = false;
  debugPrintln("NTP Sync Failed");

  return false;
}

String getTaipeiTimestamp() {
  struct tm timeinfo;

  if (!getLocalTime(&timeinfo, 100)) {
    timeSynced = false;
    return "";
  }

  char buf[40];

  strftime(
    buf,
    sizeof(buf),
    "%Y-%m-%dT%H:%M:%S+08:00",
    &timeinfo
  );

  return String(buf);
}

unsigned long getPulseCountSafe() {
  portENTER_CRITICAL(&counterMux);
  unsigned long value = PulseCount;
  portEXIT_CRITICAL(&counterMux);

  return value;
}

void updateCounter() {
  unsigned long currentPulseCount =
    getPulseCountSafe();

  // 機器不是純綠燈運轉時，不累加
  if (!countingEnabled) {
    lastHandledPulseCount = currentPulseCount;
    return;
  }

  if (currentPulseCount > lastHandledPulseCount) {
    unsigned long diff =
      currentPulseCount - lastHandledPulseCount;

    counterValue += diff;
    lastHandledPulseCount = currentPulseCount;
  }
}

uint64_t getEpochMilliseconds() {
  struct timeval now;
  if (!timeSynced || gettimeofday(&now, nullptr) != 0) {
    return 0;
  }
  return (uint64_t)now.tv_sec * 1000ULL + (uint64_t)now.tv_usec / 1000ULL;
}

uint8_t hmiChecksum(const char* text) {
  uint8_t checksum = 0;
  while (*text != '\0') {
    checksum ^= (uint8_t)*text++;
  }
  return checksum;
}

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  if (
    lastWifiTry != 0 &&
    millis() - lastWifiTry < WIFI_RETRY_MS
  ) {
    return;
  }

  lastWifiTry = millis();

  debugPrintln("");
  debugPrintln("Connecting WiFi...");

  // 只啟動連線，不在主迴圈等待； Queue與其他工作可繼續執行。
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

bool applyCounterConfig(
  uint32_t highMv,
  uint32_t lowMv,
  unsigned long highStableUs,
  unsigned long lowStableUs,
  unsigned long debounceUs,
  unsigned long version
) {
  if ( highMv <= lowMv || highMv > 5000 || lowMv > 5000 ||
    highStableUs == 0 || lowStableUs == 0 || debounceUs == 0 || version == 0 ) {
      return false;
  }

  portENTER_CRITICAL(&counterMux);
  counterHighMv = highMv;
  counterLowMv = lowMv;
  counterHighStableUs = highStableUs;
  counterLowStableUs = lowStableUs;
  counterDebounceUs = debounceUs;
  CounterHigh = latestCounterMilliVolts >= counterHighMv;
  counterConfigReady = true;
  portEXIT_CRITICAL(&counterMux);
  return true;
}

bool sendData() {
  if (WiFi.status() != WL_CONNECTED) { return false; }
  if (!timeSynced) { return false; }

  String timestamp = getTaipeiTimestamp();

  if (timestamp == "") { return false; }

  HTTPClient http;

  http.setConnectTimeout(HTTP_CONNECT_TIMEOUT_MS);
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.begin(SIGNAL_API);
  http.addHeader( "Content-Type", "application/json" );

  unsigned long deviceSendMs = millis();
  uint64_t deviceEpochMs = getEpochMilliseconds();
  if (deviceEpochMs == 0) { http.end(); return false; }
  char deviceEpochMsText[24];
  snprintf(deviceEpochMsText, sizeof(deviceEpochMsText), "%llu", (unsigned long long)deviceEpochMs);

  String statusText = getStatusText();
  bool resyncAckSent = counterResyncAckPending;

  String json = "{";

  json +=
    "\"device_id\":\"" +
    String(DEVICE_ID) +
    "\",";

  json +=
    "\"red\":" +
    String(redState) +
    ",";

  json +=
    "\"yellow\":" +
    String(yellowState) +
    ",";

  json +=
    "\"green\":" +
    String(greenState) +
    ",";

  json +=
    "\"status\":\"" +
    statusText +
    "\",";

  json +=
    "\"counter\":" +
    String(counterValue) +
    ",";

  json +=
    "\"counter_resync_ack\":" +
    String(resyncAckSent ? "true" : "false") +
    ",";

  json +=
    "\"counter_high_mv\":" +
    String(counterHighMv) +
    ",";

  json +=
    "\"counter_low_mv\":" +
    String(counterLowMv) +
    ",";

  json +=
    "\"counter_high_stable_us\":" +
    String(counterHighStableUs) +
    ",";

  json +=
    "\"counter_low_stable_us\":" +
    String(counterLowStableUs) +
    ",";

  json +=
    "\"counter_debounce_us\":" +
    String(counterDebounceUs) +
    ",";

  json +=
    "\"device_send_ms\":" +
    String(deviceSendMs) +
    ",";

  json +=
    "\"device_epoch_ms\":" +
    String(deviceEpochMsText) +
    ",";

  json +=
    "\"timestamp\":\"" +
    timestamp +
    "\"";

  json += "}";

  int httpCode = http.POST(json);

  unsigned long deviceRecvMs = millis();

  if (httpCode <= 0) {
    debugPrintln("");
    debugPrintln("HTTP POST failed");
    debugPrint("Error: ");
    debugPrintln(http.errorToString(httpCode));
    http.end();
    return false;
  }

  String response = http.getString();
  http.end();

  unsigned long rttMs = deviceRecvMs - deviceSendMs;

  String messageStr = getJsonValue(response, "message");
  String receiveStr = getJsonValue(response, "server_receive_ms");
  String doneStr = getJsonValue(response, "server_done_ms");
  String serverCounterStr = getJsonValue(response, "server_counter");
  String needResyncStr = getJsonValue(response, "need_resync");
  String resyncAcknowledgedStr = getJsonValue(response, "resync_acknowledged");

  if (DEBUG_LOG) {
    Serial.println();
    Serial.println("========== IoT LOG ==========");

    Serial.print("Time: ");
    Serial.println(timestamp);

    Serial.print("HTTP Code: ");
    Serial.println(httpCode);

    Serial.print("Status: ");
    Serial.println(statusText);

    Serial.printf(
      "RED:    GPIO%d Raw=%d (%s), State=%d (%s)\n",
      RED_PIN,
      rawRedState,
      getRawLevelText(rawRedState),
      redState,
      getOnOffText(redState)
    );

    Serial.printf(
      "YELLOW: GPIO%d Raw=%d (%s), State=%d (%s)\n",
      YELLOW_PIN,
      rawYellowState,
      getRawLevelText(rawYellowState),
      yellowState,
      getOnOffText(yellowState)
    );

    Serial.printf(
      "GREEN:  GPIO%d Raw=%d (%s), State=%d (%s)\n",
      GREEN_PIN,
      rawGreenState,
      getRawLevelText(rawGreenState),
      greenState,
      getOnOffText(greenState)
    );

    Serial.print("Counting: ");
    Serial.println( countingEnabled ? "START" : "STOP" );

    Serial.print("Counter: ");
    Serial.println(counterValue);

    Serial.print("RTT ms: ");
    Serial.println(rttMs);
  }

  if ( receiveStr != "" && doneStr != "" ) {
    unsigned long long serverReceiveMs =
      strtoull(
        receiveStr.c_str(),
        nullptr,
        10
      );

    unsigned long long serverDoneMs =
      strtoull(
        doneStr.c_str(),
        nullptr,
        10
      );

    unsigned long long serverProcessMs = serverDoneMs - serverReceiveMs;

    if (DEBUG_LOG) {
      Serial.print("server_process_ms: ");
      Serial.println( (uint64_t)serverProcessMs );
    }
  }

  if ( DEBUG_LOG && messageStr != "" ) {
    Serial.print("Server message: ");
    Serial.println(messageStr);
  }

  if ( DEBUG_LOG && serverCounterStr != "" ) {
    Serial.print("Server counter: ");
    Serial.println(serverCounterStr);
  }

  if (DEBUG_LOG) {
    Serial.print("Need resync: ");
    Serial.println( needResyncStr == "" ? "not provided" : needResyncStr );
    Serial.print("Resync ACK sent: ");
    Serial.println(resyncAckSent ? "true" : "false");
  }

  if (getJsonBool(needResyncStr)) {
    if (DEBUG_LOG) { 
      Serial.println( "Server requests counter resync" );
      Serial.println("============================="); }
    return false;
  }

  if ( resyncAckSent && getJsonBool(resyncAcknowledgedStr) ) {
    counterResyncAckPending = false;
    if (DEBUG_LOG) { Serial.println("Server accepted counter resync ACK"); }
  } 
  else if (DEBUG_LOG && resyncAckSent) {
    Serial.println("Waiting for server to accept counter resync ACK");
  }
  if (DEBUG_LOG) { Serial.println("============================="); }
  return httpCode == 200;
}

void setup(){
  Serial.begin(115200);
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  // 固定供電的IoT裝置關閉省電，降低HTTP/SSE控制通道的延遲與斷線機率。
  WiFi.setSleep(false);
  pinMode(COUNTER_PIN, INPUT);
  analogReadResolution(12);
  analogSetPinAttenuation(COUNTER_PIN, ADC_11db);
  pinMode(RED_PIN, INPUT_PULLUP);
  pinMode(YELLOW_PIN, INPUT_PULLUP);
  pinMode(GREEN_PIN, INPUT_PULLUP);
    // 計數在獨立FreeRTOS任務中每2ms（500Hz）取樣。
  xTaskCreatePinnedToCore(
      counterTask,
      "Counter",
      4096,
      nullptr,
      2,
      &counterTaskHandle,
      0
    );
  bootInitializationStartedMs = millis();
  lastReadTime = millis();
  lastSendTime = millis();
  counterConfigReady = true;
}
void loop(){
  connectWiFi();
  if (
    millis() - lastReadTime >=
    READ_INTERVAL_MS
  ) {
    lastReadTime = millis();
    readSignals();
    updateCounter();
  }

  if (
    millis() - lastSendTime >=
    SEND_INTERVAL_MS
  ) {
    lastSendTime = millis();
    lastServerPostOk = sendData();
  }
}