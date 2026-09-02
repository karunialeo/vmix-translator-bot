import speech from "@google-cloud/speech";
import { v2 as translatePkg } from "@google-cloud/translate";
import fs from "fs";
import path from "path";

process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve("./google-key.json");

const speechClient = new speech.SpeechClient();
const translateClient = new translatePkg.Translate();

async function processAudioFile() {
  const filePath = path.resolve("./file-audio-sample.mp3");

  if (!fs.existsSync(filePath)) {
    console.error(
      "File file-audio-sample.mp3 tidak ditemukan di folder project!"
    );
    return;
  }

  console.log(
    "Membaca file file-audio-sample.mp3 dan mengirim ke Google Cloud STT..."
  );
  const audioBytes = fs.readFileSync(filePath).toString("base64");

  const request = {
    audio: { content: audioBytes },
    config: {
      encoding: "MP3", // set langsung ke MP3
      sampleRateHertz: 16000, // opsional untuk MP3, bisa dihapus kalau sample rate file beda
      languageCode: "en-US",
      enableAutomaticPunctuation: true,
    },
  };

  try {
    const [response] = await speechClient.recognize(request);
    const transcript = response.results
      .map((r) => r.alternatives[0]?.transcript)
      .join("\n");

    if (!transcript) {
      console.log("Tidak ada suara terdeteksi dalam audio.");
      return;
    }

    console.log(`\n[EN - Speech to Text]: ${transcript}`);

    const [translated] = await translateClient.translate(transcript, "id");
    console.log(`[ID - Translation]   : ${translated}\n`);

    console.log("TES PIPELINE AUDIO BERHASIL 100%!");
  } catch (err) {
    console.error("Error proses audio:", err.message);
  }
}

processAudioFile();
