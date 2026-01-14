import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export async function convertWebPToMp4(
  inputPath: string,
  jobId: string,
  options: {
    outputDir?: string | null;
    quality?: 'high' | 'balanced' | 'small';
    fps?: number | null;
    background?: string | null;
  },
  onProgress?: (progress: number) => void
): Promise<string> {
  let unlisten: (() => void) | null = null;
  try {
    if (onProgress) {
      unlisten = await listen<{ job_id: string; progress: number }>('conversion-progress', (event) => {
        if (event.payload?.job_id !== jobId) return;
        if (typeof event.payload?.progress === 'number') {
          onProgress(event.payload.progress);
        }
      });
    }

    const outputPath = await invoke<string>('convert_webp_to_mp4', {
      inputPath,
      jobId,
      options: {
        outputDir: options.outputDir ?? null,
        quality: options.quality ?? 'high',
        fps: options.fps ?? null,
        background: options.background ?? null,
      },
    });

    return outputPath;
  } catch (error) {
    console.error('Conversion failed:', error);
    if (typeof error === 'string') {
      throw new Error(error);
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(JSON.stringify(error));
  } finally {
    if (unlisten) {
      unlisten();
    }
  }
}
