import speech from "@google-cloud/speech";
import { v2 as translatePkg } from "@google-cloud/translate";
import record from "node-record-lpcm16";
import axios from "axios";
import path from "path";

// ==========================================
// KONFIGURASI SISTEM
// ==========================================
const CONFIG = {
  // Kredensial Google Cloud
  keyFilename: path.resolve("./google-key.json"),

  // vMix Web API
  vmixUrl: "http://127.0.0.1:8088/api/",
  titleInputName: "SubtitleIndo", // Nama Input Title di vMix
  textFieldName: "Headline.Text", // Nama Field Text di Title vMix

  // Bahasa
  sourceLanguage: "en-US", // Bahasa narsum
  targetLanguage: "id", // Bahasa output terjemahan

  // Timer jeda kosongkan teks saat narsum diam (milidetik)
  clearDelayMs: 5000,

  // Path ke executable SoX di folder lokal
  soxPath: path.resolve("./sox.exe"),
};

// Set Environment Variable Google Cloud
process.env.GOOGLE_APPLICATION_CREDENTIALS = CONFIG.keyFilename;

const speechClient = new speech.SpeechClient();
const translateClient = new translatePkg.Translate();

let clearTimer = null;
let currentStream = null;
let audioRecordProcess = null;

// ==========================================
// FUNGSI UPDATE VMIX WEB API
// ==========================================
async function sendToVmix(text) {
  try {
    await axios.get(CONFIG.vmixUrl, {
      params: {
        Function: "SetText",
        Input: CONFIG.titleInputName,
        SelectedName: CONFIG.textFieldName,
        Value: text,
      },
    });

    // Reset auto-clear timer
    if (clearTimer) clearTimeout(clearTimer);
    clearTimer = setTimeout(async () => {
      try {
        await axios.get(CONFIG.vmixUrl, {
          params: {
            Function: "SetText",
            Input: CONFIG.titleInputName,
            SelectedName: CONFIG.textFieldName,
            Value: "",
          },
        });
      } catch (e) {
        // Silent fail saat clear
      }
    }, CONFIG.clearDelayMs);
  } catch (err) {
    console.error(`[vMix Error]: Gagal mengirim ke vMix (${err.message})`);
  }
}

// ==========================================
// PIPELINE AUDIO STREAMING & RECONNECT LOOP
// ==========================================
function startStreamPipeline() {
  console.log("[System]: Memulai streaming audio ke Google Speech-to-Text...");

  const requestConfig = {
    config: {
      encoding: "LINEAR16",
      sampleRateHertz: 16000,
      languageCode: CONFIG.sourceLanguage,
      enableAutomaticPunctuation: true,
    },
    interimResults: false, // Menunggu satu frasa/kalimat selesai agar terjemahan akurat
  };

  currentStream = speechClient
    .streamingRecognize(requestConfig)
    .on("error", (err) => {
      // Google STT streaming memiliki limit timeout ~5 menit (305s)
      console.warn(`[STT Warning/Timeout]: ${err.message}`);
      restartPipeline();
    })
    .on("data", async (data) => {
      const transcript = data.results[0]?.alternatives[0]?.transcript?.trim();
      if (transcript) {
        console.log(`\n[EN]: ${transcript}`);

        try {
          // Translate English ke Indonesia
          const [translation] = await translateClient.translate(
            transcript,
            CONFIG.targetLanguage
          );
          console.log(`[ID]: ${translation}`);

          // Kirim teks terjemahan ke vMix Title
          await sendToVmix(translation);
        } catch (tErr) {
          console.error(`[Translate Error]: ${tErr.message}`);
        }
      }
    });

  // Rekam stream mic/VB-Audio Cable menggunakan sox.exe
  audioRecordProcess = record.record({
    sampleRate: 16000,
    threshold: 0,
    verbose: false,
    recordProgram: CONFIG.soxPath,
  });

  audioRecordProcess.stream().pipe(currentStream);
  console.log(
    "[Ready]: Mendengarkan suara narsum. Tekan Ctrl+C untuk berhenti.\n"
  );
}

function restartPipeline() {
  console.log("[System]: Melakukan refresh streaming session...");

  if (currentStream) {
    currentStream.destroy();
    currentStream = null;
  }
  if (audioRecordProcess) {
    audioRecordProcess.stop();
    audioRecordProcess = null;
  }

  // Jeda 500ms sebelum inisialisasi ulang
  setTimeout(() => {
    startStreamPipeline();
  }, 500);
}

// Handle exit cleanly
process.on("SIGINT", () => {
  console.log("\n[System]: Mematikan script translator...");
  if (audioRecordProcess) audioRecordProcess.stop();
  process.exit(0);
});

// Start
startStreamPipeline();
