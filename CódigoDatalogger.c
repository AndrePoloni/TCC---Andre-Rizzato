#include <Wire.h>
#include <Adafruit_ADXL345_U.h>
#include <TinyGPS++.h>
#include <HardwareSerial.h>
#include <SPI.h>
#include <SD.h>
#include "DHT.h"
#include "esp_sleep.h"

// ===== Periféricos =====
TinyGPSPlus gps;
HardwareSerial gpsSerial(1);
#define GPS_RX 20
#define GPS_TX 21

#define SD_MISO 5
#define SD_MOSI 3
#define SD_SCK 8
#define SD_CS 10

Adafruit_ADXL345_Unified accel = Adafruit_ADXL345_Unified(12345);

#define ACC_INT_PIN GPIO_NUM_4  // ligado ao INT1 do ADXL345
#define DHTPIN 9
#define DHTTYPE DHT11
DHT dht(DHTPIN, DHTTYPE);

// ===== Deep Sleep =====
#define TIMER_WAKEUP_US (1ULL * 60ULL * 1000000ULL)  // 20 minutos
RTC_DATA_ATTR bool isFirstBoot = true;

void setup() {
  Serial.begin(115200);
  delay(200);

  esp_sleep_wakeup_cause_t wakeup_reason = esp_sleep_get_wakeup_cause();

  if (isFirstBoot) {
    Serial.println("Primeira inicialização. Configurando periféricos...");

    // Inicializa SD
    SPI.begin(SD_SCK, SD_MISO, SD_MOSI, SD_CS);
    if (!SD.begin(SD_CS)) {
      Serial.println("Erro ao iniciar cartão SD! Reiniciando...");
      delay(5000);
      ESP.restart();
    }

    // Inicializa Acelerômetro
    if (!accel.begin()) {
      Serial.println("Erro ao iniciar ADXL345. Reiniciando...");
      delay(5000);
      ESP.restart();
    }
    accel.setRange(ADXL345_RANGE_16_G);

    // Configura detecção de atividade + interrupção latched + FIFO
    accel.writeRegister(ADXL345_REG_THRESH_ACT, 40);      // Limiar
    accel.writeRegister(ADXL345_REG_ACT_INACT_CTL, 0x70);  // Detecta em XYZ
    accel.writeRegister(ADXL345_REG_INT_ENABLE, 0x10);    // Habilita ACTIVITY
    accel.writeRegister(ADXL345_REG_INT_MAP, 0x00);        // Direciona para INT1
    accel.writeRegister(ADXL345_REG_FIFO_CTL, 0b11011111); // Stream mode

    // Inicializa DHT
    dht.begin();

    isFirstBoot = false;
    Serial.println("Configuração inicial concluída.");
  } else {
    Serial.println("Acordou do deep sleep.");
    SPI.begin(SD_SCK, SD_MISO, SD_MOSI, SD_CS);
  }

  gpsSerial.begin(9600, SERIAL_8N1, GPS_RX, GPS_TX);

  // === Limpa interrupção latched do ADXL345 ===
  uint8_t intSource = accel.readRegister(ADXL345_REG_INT_SOURCE);
  Serial.print("INT_SOURCE: ");
  Serial.println(intSource, BIN);

  // === Decide ação conforme causa do wakeup ===
  if (wakeup_reason == ESP_SLEEP_WAKEUP_GPIO && (intSource & 0x10)) {
    Serial.println("Wakeup por acelerômetro.");
    salvarDados(true);  // TRUE = veio do acelerômetro
  } else if (wakeup_reason == ESP_SLEEP_WAKEUP_TIMER) {
    Serial.println("Wakeup por timer.");
    salvarDados(false); // FALSE = veio do timer
  } else {
    Serial.println("Primeira inicialização, salvando registro.");
    salvarDados(false);
  }

  // Configura próximo deep sleep
  pinMode(ACC_INT_PIN, INPUT);  // Necessário para GPIO wakeup
  esp_sleep_enable_timer_wakeup(TIMER_WAKEUP_US);
  esp_deep_sleep_enable_gpio_wakeup(1ULL << ACC_INT_PIN, ESP_GPIO_WAKEUP_GPIO_HIGH);

  Serial.println("Entrando em Deep Sleep...");
  Serial.flush();
  esp_deep_sleep_start();
}

void loop() {}

void salvarDados(bool veioDoAccel) {
  // Tenta pegar coordenadas GPS (até 15s)
  unsigned long start = millis();
  while (millis() - start < 15000) {
    if (gpsSerial.available() > 0) {
      gps.encode(gpsSerial.read());
      if (gps.location.isUpdated() && gps.location.isValid()) break;
    }
  }

  float temperatura = dht.readTemperature();
  float umidade = dht.readHumidity();
  if (isnan(temperatura)) temperatura = -99.0;
  if (isnan(umidade)) umidade = -1.0;

  float maxAceleracao = 0.0;
  if (veioDoAccel) {
    // Lê FIFO somente se acordou pelo ADXL
    uint8_t fifoSamples = accel.readRegister(ADXL345_REG_FIFO_STATUS) & 0x3F;
    Serial.print("Amostras no FIFO: ");
    Serial.println(fifoSamples);
    
    for (int i = 0; i < fifoSamples; i++) {
      int16_t x = accel.read16(ADXL345_REG_DATAX0);
      int16_t y = accel.read16(ADXL345_REG_DATAY0);
      int16_t z = accel.read16(ADXL345_REG_DATAZ0);

      // Converte os valores brutos para m/s^2
      float x_g = x * ADXL345_MG2G_MULTIPLIER * SENSORS_GRAVITY_STANDARD;
      float y_g = y * ADXL345_MG2G_MULTIPLIER * SENSORS_GRAVITY_STANDARD;
      float z_g = z * ADXL345_MG2G_MULTIPLIER * SENSORS_GRAVITY_STANDARD;

      float currentAceleracao = sqrt(pow(x_g, 2) + pow(y_g, 2) + pow(z_g, 2));

      if (currentAceleracao > maxAceleracao) {
        maxAceleracao = currentAceleracao;
      }
    }
  }

  String latitude = gps.location.isValid() ? String(gps.location.lat(), 6) : "N/A";
  String longitude = gps.location.isValid() ? String(gps.location.lng(), 6) : "N/A";

  String log = latitude + "," + longitude + "," +
               String(temperatura, 1) + "," +
               String(umidade, 1) + "," +
               String(maxAceleracao, 2);

  File file = SD.open("/data_log.csv", FILE_APPEND);
  if (file) {
    file.println(log);
    file.flush();
    file.close();
    Serial.println("Dados gravados no SD:");
    Serial.println(log);
  } else {
    Serial.println("Erro ao abrir arquivo para gravação!");
  }

  Serial.println("--------------------------");
}