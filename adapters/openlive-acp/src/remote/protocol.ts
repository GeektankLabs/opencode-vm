export const REMOTE_PROTOCOL = "ocvm-openlive.v1";
export const REMOTE_SCHEMA = 1;
export const MAX_ACP_MESSAGE_BYTES = 12 * 1024 * 1024;
export const MAX_QUEUE_BYTES = 24 * 1024 * 1024;

export type RemoteInfo = {
  schema: 1;
  protocol: typeof REMOTE_PROTOCOL;
  scriptVersion: string;
  adapterVersion: string;
  projectId: string;
  displayName: string;
  ready: boolean;
  busy: boolean;
  maxJpegFrameBytes: number;
  acpPath: "/openlive/acp";
};

export type RemoteReady = {
  type: "ready";
  protocol: typeof REMOTE_PROTOCOL;
  projectId: string;
  generation: string;
  cwd: string;
  busy: boolean;
};

export type RemoteError = {
  type: "error";
  code: string;
  message: string;
};

export type RemoteEof = {
  type: "eof";
};
