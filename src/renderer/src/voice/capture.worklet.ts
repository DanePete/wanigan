// Voice input's AudioWorklet: the microphone's samples, already at 16 kHz (the
// AudioContext resamples them), handed to the window in 100 ms chunks. Built as
// a file of its own (lib/voice.ts imports its address), because a worklet is
// loaded by address and the window's policy allows only its own scripts.

// The AudioWorkletGlobalScope's names, which TypeScript's DOM library does not carry.
declare const sampleRate: number;
declare function registerProcessor(name: string, processor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const CHUNK = 1_600;

class Capture extends AudioWorkletProcessor {
  private buffer = new Float32Array(CHUNK);
  private filled = 0;

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    let i = 0;
    while (i < channel.length) {
      const n = Math.min(channel.length - i, CHUNK - this.filled);
      this.buffer.set(channel.subarray(i, i + n), this.filled);
      this.filled += n;
      i += n;
      if (this.filled === CHUNK) {
        const out = this.buffer;
        this.port.postMessage({ samples: out, rate: sampleRate }, [out.buffer]);
        this.buffer = new Float32Array(CHUNK);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('wanigan-voice-capture', Capture);
