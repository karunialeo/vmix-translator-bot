import speech from "@google-cloud/speech";
import { v2 as translatePkg } from "@google-cloud/translate";
import AudioRecorder from "node-audiorecorder";
import path from "path";

process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve("./google-key.json");

const speechClient = new speech.SpeechClient();
const translateClient = new translatePkg.Translate();

const audioRecorder = new AudioRecorder(
  {
    program: "rec", // atau 'sox' kalau ada, tapi default node-audiorecorder bisa fallback
    silence: 0,
  },
  console
);

const request = {
  config: {
    encoding: "LINEAR16",
    sampleRateHertz: 16000,
    languageCode: "en-US",
    enableAutomaticPunctuation: true,
  },
  interimResults: false,
};

console.log(
  "Mulai ngomong bahasa Inggris ke mic laptop lu sekarang... (Tekan Ctrl+C buat stop)"
);

const recognizeStream = speechClient
  .streamingRecognize(request)
  .on("error", (err) => console.error("STT Error:", err.message))
  .on("data", async (data) => {
    const transcript = data.results[0]?.alternatives[0]?.transcript;
    if (transcript) {
      console.log(`\n[EN]: ${transcript}`);
      const [translated] = await translateClient.translate(transcript, "id");
      console.log(`[ID]: ${translated}`);
    }
  });

audioRecorder.start().stream().pipe(recognizeStream);
