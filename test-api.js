import speech from "@google-cloud/speech";
import { v2 as translatePkg } from "@google-cloud/translate";
import path from "path";

// Load Service Account JSON
process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve("./google-key.json");

const speechClient = new speech.SpeechClient();
const translateClient = new translatePkg.Translate();

async function runTest() {
  console.log("--- 1. Testing Translation API ---");
  try {
    const sampleText =
      "Good morning everyone, welcome to today live broadcast.";
    const [translation] = await translateClient.translate(sampleText, "id");
    console.log(`Input English : "${sampleText}"`);
    console.log(`Output Indo   : "${translation}"`);
    console.log("STATUS: Translation API aman!\n");
  } catch (err) {
    console.error("STATUS: Translation API error:", err.message);
    return;
  }

  console.log("--- 2. Testing Speech-to-Text API Connection ---");
  try {
    // Ping API speech dengan request config sederhana
    // (Tanpa audio dulu untuk memastikan auth credential dan API permission valid)
    const request = {
      config: {
        encoding: "LINEAR16",
        sampleRateHertz: 16000,
        languageCode: "en-US",
      },
      audio: {
        content: "", // payload kosong untuk test handshake
      },
    };

    // Panggil recognize (akan melempar error payload kosong jika koneksi/auth berhasil)
    await speechClient.recognize(request).catch((err) => {
      if (err.message.includes("audio") || err.code === 3) {
        console.log(
          "Handshake Speech-to-Text berhasil (Koneksi & Auth VALID)!"
        );
      } else {
        throw err;
      }
    });

    console.log("STATUS: Speech-to-Text API siap dipakai!\n");
    console.log("SEMUA API GOOGLE BERHASIL DIVERIFIKASI!");
  } catch (err) {
    console.error("STATUS: Speech-to-Text API error:", err.message);
  }
}

runTest();
