// Enregistre le micro en WAV 16 kHz mono (ce que Whisper attend) et s'arrête tout seul après un silence.

const WORKLET = `class Rec extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch && ch.length) this.port.postMessage(ch.slice(0)); return true; }
}
registerProcessor("cv-rec", Rec);`;

const MAX_MS = 180_000; // garde-fou : un micro oublié ouvert ne dure pas plus de 3 minutes
const NOBODY_MS = 10_000; // rien dit du tout au bout de 10 s : on abandonne

export interface Recording {
  /** Termine l'enregistrement. `wav` est null si rien d'audible n'a été capté. */
  finish(): Promise<{ wav: Blob | null }>;
  cancel(): void;
}

export interface RecordOptions {
  /** Niveau sonore lissé, de 0 à 1 (pour animer le bouton). */
  onLevel?: (level: number) => void;
  /** L'enregistrement devrait s'arrêter (silence après la parole, ou personne n'a parlé). */
  onAutoStop?: () => void;
  silenceMs?: number;
}

function encodeWav(chunks: Float32Array[], rate: number): Blob {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new ArrayBuffer(44 + total * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + total * 2, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, total * 2, true);
  let o = 44;
  for (const c of chunks) for (let i = 0; i < c.length; i++, o += 2) v.setInt16(o, Math.max(-1, Math.min(1, c[i])) * 0x7fff, true);
  return new Blob([buf], { type: "audio/wav" });
}

export async function startRecording(opts: RecordOptions = {}): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  let ctx: AudioContext | null = null;
  try {
    ctx = new AudioContext({ sampleRate: 16000 });
    await ctx.resume();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    void ctx?.close();
    throw e;
  }
  const audio = ctx;
  const src = audio.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(audio, "cv-rec");
  const mute = audio.createGain(); // le nœud doit être relié à la sortie pour être exécuté, mais on n'entend rien
  mute.gain.value = 0;
  src.connect(node); node.connect(mute); mute.connect(audio.destination);

  const chunks: Float32Array[] = [];
  const silenceMs = opts.silenceMs ?? 1800;
  const t0 = performance.now();
  let smooth = 0, floor = 0, floorN = 0, heard = false, lastVoice = t0, stopped = false, fired = false;

  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    if (stopped) return;
    const c = e.data;
    chunks.push(c);
    let sum = 0;
    for (let i = 0; i < c.length; i++) sum += c[i] * c[i];
    smooth = smooth * 0.85 + Math.sqrt(sum / c.length) * 0.15;
    opts.onLevel?.(Math.min(1, smooth * 6));
    const now = performance.now();
    if (now - t0 < 400) { floor += smooth; floorN++; return; } // les 0,4 premières secondes servent à mesurer le bruit ambiant
    const threshold = Math.max(0.012, Math.min(0.03, floor / Math.max(1, floorN)) * 3);
    if (smooth > threshold) { heard = true; lastVoice = now; }
    const idle = heard ? now - lastVoice > silenceMs : now - t0 > NOBODY_MS;
    if (!fired && (idle || now - t0 > MAX_MS)) { fired = true; opts.onAutoStop?.(); }
  };

  const release = () => {
    stopped = true;
    node.port.onmessage = null;
    stream.getTracks().forEach((t) => t.stop());
    void audio.close();
    opts.onLevel?.(0);
  };

  return {
    async finish() {
      const rate = audio.sampleRate;
      release();
      const samples = chunks.reduce((n, c) => n + c.length, 0);
      return { wav: heard && samples > rate * 0.3 ? encodeWav(chunks, rate) : null };
    },
    cancel: release,
  };
}
