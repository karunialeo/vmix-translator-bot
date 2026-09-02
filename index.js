import speech from "@google-cloud/speech";
import { v2 as translatePkg } from "@google-cloud/translate";
import { spawn } from "child_process";
import axios from "axios";
import path from "path";

// ==========================================
// KONFIGURASI SISTEM
// ==========================================
const CONFIG = {
  // Path file kredensial service account Google Cloud
  keyFilename: path.resolve("./google-key.json"),

  // Nama device audio di Windows (ganti sesuai hasil cek ffmpeg di Step 1)
  // Contoh: 'Microphone Array (Realtek(R) Audio)' atau 'CABLE Output (VB-Audio Virtual Cable)'
  audioDeviceName: "Microphone Array (Realtek(R) Audio)",

  // Konfigurasi vMix Web API
  vmixUrl: "http://127.0.0.1:8088/api/",
  titleInputName: "SubtitleIndo", // Nama Input Title di vMix
  textFieldName: "Headline.Text", // Nama Field Text di Title vMix

  // Bahasa
  sourceLanguage: "en-US", // Bahasa narsum
  targetLanguage: "id", // Bahasa output terjemahan

  // Timer kosongkan teks otomatis jika narsum diam (milidetik)
  clearDelayMs: 5000,
};

// Set Environment Variable Google Cloud
process.env.GOOGLE_APPLICATION_CREDENTIALS = CONFIG.keyFilename;

const speechClient = new speech.SpeechClient();
const translateClient = new translatePkg.Translate();

let clearTimer = null;
let currentStream = null;
let ffmpegProcess = null;

// ==========================================
// FUNGSI UPDATE VMIX TITLE
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

    // Auto-clear teks di layar jika narsum diam
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
      } catch (e) {}
    }, CONFIG.clearDelayMs);
  } catch (err) {
    console.error(`[vMix Info]: ${err.message}`);
  }
}

// ==========================================
// PIPELINE STREAMING & RECONNECT LOOP
// ==========================================
function startStreamPipeline() {
  console.log("[System]: Menghubungkan ke Google Streaming STT...");

  const requestConfig = {
    config: {
      encoding: "LINEAR16",
      sampleRateHertz: 16000,
      languageCode: CONFIG.sourceLanguage,
      enableAutomaticPunctuation: true,
    },
    interimResults: false, // Kalimat penuh agar terjemahan tidak bolak-balik
  };

  currentStream = speechClient
    .streamingRecognize(requestConfig)
    .on("error", (err) => {
      console.warn(`[STT Timeout/Notice]: ${err.message}`);
      restartPipeline();
    })
    .on("data", async (data) => {
      const transcript = data.results[0]?.alternatives[0]?.transcript?.trim();
      if (transcript) {
        console.log(`\n[EN]: ${transcript}`);

        try {
          const [translation] = await translateClient.translate(
            transcript,
            CONFIG.targetLanguage
          );
          console.log(`[ID]: ${translation}`);
          await sendToVmix(translation);
        } catch (tErr) {
          console.error(`[Translate Error]: ${tErr.message}`);
        }
      }
    });

  // Parameter FFmpeg untuk rekam audio Windows DirectShow (dshow)
  const ffmpegArgs = [
    "-f",
    "dshow",
    "-i",
    `audio=${CONFIG.audioDeviceName}`,
    "-ar",
    "16000", // 16kHz
    "-ac",
    "1", // Mono
    "-f",
    "s16le", // Raw PCM 16-bit
    "pipe:1", // Output langsung ke stdout
  ];

  ffmpegProcess = spawn("ffmpeg", ffmpegArgs, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  ffmpegProcess.stderr.on("data", (data) => {
    const msg = data.toString();
    // Tampilkan jika ada error device tidak ditemukan
    if (msg.includes("Could not find audio device") || msg.includes("Error")) {
      console.error(`[FFmpeg Error]: ${msg}`);
    }
  });

  ffmpegProcess.on("exit", (code) => {
    if (code !== null && code !== 0 && code !== 255) {
      console.warn(`[FFmpeg Exit]: Proses berhenti dengan code ${code}`);
    }
  });

  // Alirkan buffer audio langsung ke Google STT
  ffmpegProcess.stdout.pipe(currentStream);

  console.log(
    `[Ready]: Mic "${CONFIG.audioDeviceName}" aktif! Silakan bicara bahasa Inggris. (Ctrl+C untuk stop)\n`
  );
}

function restartPipeline() {
  console.log("[System]: Refreshing session stream...");
  if (currentStream) {
    currentStream.destroy();
    currentStream = null;
  }
  if (ffmpegProcess) {
    ffmpegProcess.kill("SIGKILL");
    ffmpegProcess = null;
  }

  setTimeout(() => {
    startStreamPipeline();
  }, 500);
}

process.on("SIGINT", () => {
  console.log("\n[System]: Script dihentikan.");
  if (ffmpegProcess) ffmpegProcess.kill("SIGKILL");
  process.exit(0);
});

startStreamPipeline();
