import { spawn } from "child_process";

const ffmpeg = spawn("ffmpeg", ["-list_devices", "true", "-f", "dshow", "-i", "dummy"]);

let output = "";

// FFmpeg mengeluarkan daftar device di stderr
ffmpeg.stderr.on("data", (data) => {
  output += data.toString();
});

ffmpeg.on("close", () => {
  console.log("\n================ DAFTAR AUDIO DEVICE (DSHOW) ================");
  
  // Mencari baris yang berakhiran (audio)
  const regex = /"([^"]+)"\s+\(audio\)/g;
  let match;
  let count = 0;

  while ((match = regex.exec(output)) !== null) {
    count++;
    console.log(`${count}. "${match[1]}"`);
  }

  if (count === 0) {
    console.log("Tidak ada audio device yang terdeteksi.");
  } else {
    console.log("=============================================================");
    console.log("Salin salah satu nama di atas (termasuk tanda kutip atau isinya saja)");
    console.log("ke konfigurasi `audioDeviceName` di index.js atau test-mic.js\n");
  }
});
