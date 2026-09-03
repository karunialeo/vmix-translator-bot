import speech from "@google-cloud/speech";
import { v2 as translatePkg } from "@google-cloud/translate";
import { spawn } from "child_process";
import path from "path";

// ==========================================
// KONFIGURASI TEST MIC & SMART CHUNKING
// ==========================================
const CONFIG = {
  keyFilename: path.resolve("./google-key.json"),
  audioDeviceName: "Microphone Array (Realtek(R) Audio)",
  sourceLanguage: "en-US",
  targetLanguage: "id",

  // Parameter Smart Chunking
  minWordsPerChunk: 6, // Minimal kata sebelum mencari titik potong alami
  maxWordsPerChunk: 10, // Maksimal kata (potong paksa jika tidak ada jeda)
};

process.env.GOOGLE_APPLICATION_CREDENTIALS = CONFIG.keyFilename;

const speechClient = new speech.SpeechClient();
const translateClient = new translatePkg.Translate();

// State untuk 2-line rolling subtitle simulation
let line1 = ""; // Baris 1 (Atas / Kalimat Sebelumnya)
let line2 = ""; // Baris 2 (Bawah / Kalimat Terkini)
let lastTimestamp = null; // Untuk kalkulasi jeda waktu antar-chunk

// Queue terjemahan agar urutan tampil di console tetap rapi & sequential
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

  // Jika narsum sudah berhenti bicara (isFinal = true), ambil semua sisa kata
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
// SETUP STREAMING GOOGLE STT DENGAN INTERIM
// ==========================================
const requestConfig = {
  config: {
    encoding: "LINEAR16",
    sampleRateHertz: 16000,
    languageCode: CONFIG.sourceLanguage,
    enableAutomaticPunctuation: true,
  },
  interimResults: true, // AKTIF: Kirim audio real-time saat narsum bicara
};

console.log("[System]: Menyiapkan Google STT Stream (Smart Chunking Aktif)...");

let committedLength = 0;

const recognizeStream = speechClient
  .streamingRecognize(requestConfig)
  .on("error", (err) => {
    console.error(`\n[STT Error]: ${err.message}`);
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

      // Masukkan ke queue terjemahan
      translationQueue.push(chunk);
      processTranslationQueue();

      if (isFinal) break;
    }

    if (isFinal) {
      committedLength = 0;
    }
  });

// ==========================================
// AUDIO RECORDING VIA FFMPEG DIRECTSHOW
// ==========================================
const ffmpegArgs = [
  "-f",
  "dshow",
  "-i",
  `audio=${CONFIG.audioDeviceName}`,
  "-ar",
  "16000",
  "-ac",
  "1",
  "-f",
  "s16le",
  "pipe:1",
];

const ffmpegProcess = spawn("ffmpeg", ffmpegArgs, {
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});

ffmpegProcess.stderr.on("data", (data) => {
  const msg = data.toString();
  if (msg.includes("Could not find audio device") || msg.includes("Error")) {
    console.error(`\n[FFmpeg Error]: ${msg}`);
  }
});

ffmpegProcess.on("exit", (code) => {
  if (code !== null && code !== 0 && code !== 255) {
    console.warn(`\n[FFmpeg Exit]: Proses berhenti dengan code ${code}`);
  }
});

ffmpegProcess.stdout.pipe(recognizeStream);

console.log(
  `[Ready]: Smart Chunking aktif pada mic "${CONFIG.audioDeviceName}"!\n` +
    `Coba bicarakan kalimat panjang dalam bahasa Inggris.\n` +
    `Perhatikan bagaimana kalimat dipecah per 6-10 kata dan mengalir ke tampilan 2 baris.\n` +
    `(Tekan Ctrl+C untuk berhenti)\n`
);

process.on("SIGINT", () => {
  console.log("\n[System]: Testing dihentikan.");
  if (ffmpegProcess) ffmpegProcess.kill("SIGKILL");
  process.exit(0);
});
