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

  // Nama device audio di Windows (sesuaikan dengan mic Anda)
  audioDeviceName: "Microphone Array (Realtek(R) Audio)",

  // Konfigurasi vMix Web API
  vmixUrl: "http://127.0.0.1:8088/api/",
  titleInputName: "SubtitleIndo", // Nama Input Title di vMix
  textFieldName: "Headline.Text", // Field teks di vMix (menggabungkan 2 baris dengan newline \n)

  // Opsi jika memiliki field baris ke-2 terpisah di vMix Title (set null jika pakai 1 field multiline)
  textFieldNameLine2: null,

  // Bahasa
  sourceLanguage: "en-US", // Bahasa narsum
  targetLanguage: "id", // Bahasa output terjemahan

  // Parameter Smart Chunking
  minWordsPerChunk: 6, // Minimal kata sebelum mencari titik potong alami
  maxWordsPerChunk: 10, // Maksimal kata (potong paksa jika tidak ada jeda)
};

// Set Environment Variable Google Cloud
process.env.GOOGLE_APPLICATION_CREDENTIALS = CONFIG.keyFilename;

const speechClient = new speech.SpeechClient();
const translateClient = new translatePkg.Translate();

let currentStream = null;
let ffmpegProcess = null;
let committedLength = 0;

// State untuk 2-line rolling subtitle
let line1 = ""; // Baris 1 (Atas / Kalimat Sebelumnya)
let line2 = ""; // Baris 2 (Bawah / Kalimat Terkini)
let lastTimestamp = null; // Untuk kalkulasi jeda waktu antar-chunk

// ==========================================
// FUNGSI UPDATE VMIX TITLE
// ==========================================
async function sendToVmix(l1, l2) {
  try {
    if (CONFIG.textFieldNameLine2) {
      // Jika menggunakan 2 field teks terpisah di template vMix
      await Promise.all([
        axios.get(CONFIG.vmixUrl, {
          params: {
            Function: "SetText",
            Input: CONFIG.titleInputName,
            SelectedName: CONFIG.textFieldName,
            Value: l1 || "",
          },
        }),
        axios.get(CONFIG.vmixUrl, {
          params: {
            Function: "SetText",
            Input: CONFIG.titleInputName,
            SelectedName: CONFIG.textFieldNameLine2,
            Value: l2 || "",
          },
        }),
      ]);
    } else {
      // Mode default: gabungkan baris 1 dan baris 2 dengan newline (\n)
      const combinedText = l1 ? `${l1}\n${l2}` : l2;
      await axios.get(CONFIG.vmixUrl, {
        params: {
          Function: "SetText",
          Input: CONFIG.titleInputName,
          SelectedName: CONFIG.textFieldName,
          Value: combinedText,
        },
      });
    }
  } catch (err) {
    console.error(`[vMix Info]: ${err.message}`);
  }
}

// ==========================================
// ANTRIAN TERJEMAHAN & PROSES KE VMIX
// ==========================================
let isProcessingQueue = false;
const translationQueue = [];

async function processTranslationQueue() {
  if (isProcessingQueue || translationQueue.length === 0) return;
  isProcessingQueue = true;

  while (translationQueue.length > 0) {
    const chunkEn = translationQueue.shift();
    try {
      const [translated] = await translateClient.translate(
        chunkEn,
        CONFIG.targetLanguage
      );

      // Geser baris: baris 2 naik ke baris 1, baris baru masuk ke baris 2
      line1 = line2;
      line2 = translated;

      const now = new Date();
      const timeStr =
        now.toTimeString().split(" ")[0] +
        "." +
        String(now.getMilliseconds()).padStart(3, "0");
      const deltaStr = lastTimestamp
        ? `(+${((now - lastTimestamp) / 1000).toFixed(2)} detik dari chunk sebelumnya)`
        : `(Chunk pertama)`;
      lastTimestamp = now;

      console.log(`\n⏱️  [${timeStr}] ${deltaStr}`);
      console.log(`[EN Chunk]: "${chunkEn}"`);
      console.log(`[ID Chunk]: "${translated}"`);
      console.log(`┌─────────────────────────────────────────────────────────────┐`);
      console.log(`│ [1. Baris Atas ] : ${(line1 || "-").padEnd(41)}│`);
      console.log(`│ [2. Baris Bawah] : ${(line2 || "-").padEnd(41)}│`);
      console.log(`└─────────────────────────────────────────────────────────────┘`);

      // Kirim hasil rolling 2 baris ke vMix
      await sendToVmix(line1, line2);
    } catch (err) {
      console.error(`[Translate Error]: ${err.message}`);
    }
  }

  isProcessingQueue = false;
}

// ==========================================
// LOGIKA SMART CHUNKING
// ==========================================
function extractNextChunk(text, isFinal) {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const words = trimmed.split(/\s+/);
  if (words.length === 0 || words[0] === "") return null;

  // Jika narsum berhenti bicara (isFinal = true), ambil semua sisa kata
  if (isFinal) {
    return trimmed;
  }

  // Belum mencapai batas minimum kata, biarkan narsum bicara dulu
  if (words.length < CONFIG.minWordsPerChunk) {
    return null;
  }

  // 1. Cek tanda baca alami (. , ? ! ; :) dari kata ke-4 sampai maxWords
  for (let i = 4; i < Math.min(words.length, CONFIG.maxWordsPerChunk); i++) {
    if (/[.,?!;:]$/.test(words[i])) {
      return words.slice(0, i + 1).join(" ");
    }
  }

  // 2. Cek kata sambung alami (conjunctions) dari kata ke-5 sampai maxWords
  const conjunctions = [
    "and",
    "but",
    "so",
    "because",
    "or",
    "then",
    "which",
    "that",
    "where",
    "when",
  ];
  for (let i = 5; i < Math.min(words.length, CONFIG.maxWordsPerChunk); i++) {
    const cleanWord = words[i].toLowerCase().replace(/[^a-z]/g, "");
    if (conjunctions.includes(cleanWord)) {
      return words.slice(0, i).join(" ");
    }
  }

  // 3. Jika sudah mencapai maxWords tanpa jeda, potong paksa di maxWords
  if (words.length >= CONFIG.maxWordsPerChunk) {
    return words.slice(0, CONFIG.maxWordsPerChunk).join(" ");
  }

  return null;
}

// ==========================================
// PIPELINE STREAMING & RECONNECT LOOP
// ==========================================
function startStreamPipeline() {
  console.log("[System]: Menghubungkan ke Google Streaming STT (Smart Chunking)...");

  committedLength = 0;

  const requestConfig = {
    config: {
      encoding: "LINEAR16",
      sampleRateHertz: 16000,
      languageCode: CONFIG.sourceLanguage,
      enableAutomaticPunctuation: true,
    },
    interimResults: true, // AKTIF: Kirim audio real-time saat narsum bicara
  };

  currentStream = speechClient
    .streamingRecognize(requestConfig)
    .on("error", (err) => {
      console.warn(`[STT Timeout/Notice]: ${err.message}`);
      restartPipeline();
    })
    .on("data", (data) => {
      const result = data.results[0];
      if (!result || !result.alternatives || !result.alternatives[0]) return;

      const fullTranscript = result.alternatives[0].transcript || "";
      const isFinal = result.isFinal;

      // Reset offset jika Google mereset buffer transkrip
      if (fullTranscript.length < committedLength) {
        committedLength = 0;
      }

      let sub = fullTranscript.slice(committedLength);
      let remainingText = sub.trim();

      while (remainingText.length > 0) {
        const chunk = extractNextChunk(remainingText, isFinal);
        if (!chunk || chunk.trim().length === 0) break;

        // Update pointer posisi karakter yang sudah di-commit
        const idx = sub.indexOf(chunk);
        if (idx !== -1) {
          committedLength += idx + chunk.length;
          sub = fullTranscript.slice(committedLength);
          remainingText = sub.trim();
        } else {
          break;
        }

        // Masukkan ke antrean terjemahan & vMix
        translationQueue.push(chunk);
        processTranslationQueue();

        if (isFinal) break;
      }

      if (isFinal) {
        committedLength = 0;
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
    `[Ready]: Bot aktif pada mic "${CONFIG.audioDeviceName}"!\n` +
      `Silakan bicara bahasa Inggris. Teks terjemahan akan otomatis dialirkan ke vMix.\n` +
      `(Tekan Ctrl+C untuk stop)\n`
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

  committedLength = 0;

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
