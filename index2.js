import speech from "@google-cloud/speech";
import { v2 as translatePkg } from "@google-cloud/translate";
import { spawn } from "child_process";
import axios from "axios";
import path from "path";

// ==========================================================
// KONFIGURASI SISTEM (OPSI YOUTUBE LIVE STYLE / INTERIM DRAFT)
// ==========================================================
const CONFIG = {
  // Path file kredensial service account Google Cloud
  keyFilename: path.resolve("./google-key.json"),

  // Nama device audio di Windows
  audioDeviceName: "Microphone Array (Realtek(R) Audio)",

  // Konfigurasi vMix Web API
  vmixUrl: "http://192.168.0.24:8088/api/",
  titleInputName: "SubtitleIndo", // Nama Input Title di vMix
  textFieldName: "Headline.Text", // Field teks di vMix

  // Opsi jika memiliki field baris ke-2 terpisah di vMix Title (set null jika pakai 1 field multiline)
  textFieldNameLine2: null,

  // Bahasa
  sourceLanguage: "en-US", // Bahasa narsum
  targetLanguage: "id", // Bahasa output terjemahan

  // Throttle jeda translate saat narsum bicara (milidetik)
  // Menjaga agar subtitle update berkala tanpa membebani kuota API Translate
  throttleMs: 350,

  // Batas maksimal kata yang muncul bersamaan (mencegah teks kepanjangan di layar)
  maxWordsPerLine: 8,
};

// Set Environment Variable Google Cloud
process.env.GOOGLE_APPLICATION_CREDENTIALS = CONFIG.keyFilename;

const speechClient = new speech.SpeechClient();
const translateClient = new translatePkg.Translate();

let currentStream = null;
let ffmpegProcess = null;
let committedOffset = 0; // Penanda offset teks yang sudah di-commit/roll

// State untuk 2-line subtitle (Baris 1 = Kalimat Selesai, Baris 2 = Kalimat Berjalan)
let line1 = ""; // Baris Atas (Previous sentence / sudah final)
let line2 = ""; // Baris Bawah (Live drafting yang sedang diucapkan)
let lastTimestamp = null;

// Variabel kontrol throttling
let throttleTimer = null;
let latestDraftText = "";
let requestId = 0;

// ==========================================
// FUNGSI UPDATE VMIX TITLE
// ==========================================
async function sendToVmix(l1, l2) {
  try {
    if (CONFIG.textFieldNameLine2) {
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
// EKSEKUSI TERJEMAHAN & PENGIRIMAN
// ==========================================
async function executeTranslate(text, isFinal) {
  const currentId = ++requestId;

  try {
    const [translated] = await translateClient.translate(
      text,
      CONFIG.targetLanguage
    );

    // Abaikan jika request ini basi (sudah ada teks yang lebih baru selesai)
    if (currentId < requestId && !isFinal) return;

    line2 = translated;

    const now = new Date();
    const timeStr =
      now.toTimeString().split(" ")[0] +
      "." +
      String(now.getMilliseconds()).padStart(3, "0");
    const deltaStr = lastTimestamp
      ? `(+${((now - lastTimestamp) / 1000).toFixed(2)}s)`
      : `(Mulai)`;
    lastTimestamp = now;

    console.log(
      `\n⏱️  [${timeStr}] ${deltaStr} ${isFinal ? "🟢 [FINAL]" : "🟡 [LIVE DRAFT]"}`
    );
    console.log(`[EN]: "${text}"`);
    console.log(`[ID]: "${translated}"`);
    console.log(`┌─────────────────────────────────────────────────────────────┐`);
    console.log(`│ [1. Baris Atas - Previous ] : ${(line1 || "-").padEnd(31)}│`);
    console.log(`│ [2. Baris Bawah - Live Now] : ${(line2 || "-").padEnd(31)}│`);
    console.log(`└─────────────────────────────────────────────────────────────┘`);

    await sendToVmix(line1, line2);

    if (isFinal) {
      // Kalimat selesai: baris 2 naik ke baris 1, baris 2 siap menerima kalimat baru
      line1 = line2;
      line2 = "";
    }
  } catch (err) {
    console.error(`[Translate Error]: ${err.message}`);
  }
}

function handleIncomingTranscript(transcript, isFinal) {
  // Jika Google STT mereset buffer atau memulai kalimat baru
  if (transcript.length < committedOffset) {
    committedOffset = 0;
  }

  let currentSub = transcript.slice(committedOffset);
  let activeText = currentSub.trim();
  if (!activeText && !isFinal) return;

  const words = activeText ? activeText.split(/\s+/) : [];

  // Jika kata yang sedang diucapkan sudah mencapai atau melebihi batas maksimal (8 kata)
  if (words.length >= CONFIG.maxWordsPerLine) {
    // Cari titik potong alami antara kata ke-10 sampai batas maksimal
    let splitIdx = CONFIG.maxWordsPerLine;
    for (let i = 10; i < CONFIG.maxWordsPerLine; i++) {
      if (/[.,?!;:]$/.test(words[i])) {
        splitIdx = i + 1;
        break;
      }
    }

    // Jika tidak ada tanda baca, periksa kata sambung
    if (splitIdx === CONFIG.maxWordsPerLine) {
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
      for (let i = 10; i < CONFIG.maxWordsPerLine; i++) {
        const cleanWord = words[i].toLowerCase().replace(/[^a-z]/g, "");
        if (conjunctions.includes(cleanWord)) {
          splitIdx = i;
          break;
        }
      }
    }

    const chunkToCommit = words.slice(0, splitIdx).join(" ");
    const idxInSub = currentSub.indexOf(chunkToCommit);
    if (idxInSub !== -1) {
      committedOffset += idxInSub + chunkToCommit.length;
    }

    // Commit potongan 8 kata ini sebagai FINAL sehingga naik ke Baris Atas (line1)
    if (throttleTimer) {
      clearTimeout(throttleTimer);
      throttleTimer = null;
    }
    executeTranslate(chunkToCommit, true);

    // Sisa kata langsung menjadi activeText baru untuk Baris Bawah (line2)
    currentSub = transcript.slice(committedOffset);
    activeText = currentSub.trim();
  }

  if (isFinal) {
    // Jika narsum berhenti bicara, proses sisa kata dan reset offset
    if (throttleTimer) {
      clearTimeout(throttleTimer);
      throttleTimer = null;
    }
    if (activeText) {
      executeTranslate(activeText, true);
    }
    committedOffset = 0;
    return;
  }

  // Jika masih di bawah batas maksimal 8 kata, update live draft berkala via throttle
  if (!activeText) return;
  latestDraftText = activeText;

  if (throttleTimer) return;

  throttleTimer = setTimeout(() => {
    throttleTimer = null;
    executeTranslate(latestDraftText, false);
  }, CONFIG.throttleMs);
}

// ==========================================
// PIPELINE STREAMING & RECONNECT LOOP
// ==========================================
function startStreamPipeline() {
  console.log(
    "[System]: Menghubungkan ke Google Streaming STT (YouTube Live Style)..."
  );

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

      const transcript = result.alternatives[0].transcript || "";
      const isFinal = result.isFinal;

      handleIncomingTranscript(transcript, isFinal);
    });

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

  ffmpegProcess.stdout.pipe(currentStream);

  console.log(
    `[Ready]: Bot YouTube-Style aktif pada mic "${CONFIG.audioDeviceName}"!\n` +
      `Bicaralah ke mic. Terjemahan akan berkembang langsung di layar vMix secara real-time.\n` +
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

  if (throttleTimer) {
    clearTimeout(throttleTimer);
    throttleTimer = null;
  }

  committedOffset = 0;

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
