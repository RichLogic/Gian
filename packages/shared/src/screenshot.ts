/** The composer that owns a screenshot at the instant capture starts. */
export type GianScreenshotTarget =
  | {
      kind: 'session';
      sessionId: string;
      label: string;
    }
  | {
      kind: 'new-session';
      scope: {
        kind: 'workspace' | 'task';
        id: string;
      };
      label: string;
    };

export type GianScreenshotErrorCode =
  | 'busy'
  | 'capture-failed'
  | 'no-target'
  | 'permission-denied'
  | 'shortcut-unavailable';

export interface GianScreenshotStartResult {
  ok: boolean;
  error?: GianScreenshotErrorCode;
}

export interface GianScreenshotState {
  shortcut: string;
  shortcutRegistered: boolean;
  capturing: boolean;
}

export interface GianScreenshotCapture {
  id: string;
  target: GianScreenshotTarget;
  filename: string;
  mime: 'image/png';
  bytes: Uint8Array;
}

/** Node-free screenshot surface exposed only to Gian's trusted web renderer. */
export interface GianScreenshotApi {
  setTarget(target: GianScreenshotTarget | null): Promise<boolean>;
  start(): Promise<GianScreenshotStartResult>;
  getState(): Promise<GianScreenshotState>;
  onCaptured(listener: (capture: GianScreenshotCapture) => void): () => void;
  onError(listener: (error: GianScreenshotErrorCode) => void): () => void;
}
