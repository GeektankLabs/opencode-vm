export type RuntimeDescriptor = {
  schema: 1;
  project: string;
  backendUrl: string;
  generation: string;
  opencodeVersion: string;
};

export type ManagerDescriptor = {
  schema: 1;
  project: string;
  sessionId: string;
};

export type SessionSummary = {
  id: string;
  title: string;
  updated: number;
  status: string;
};

export type SessionListing = {
  total: number;
  busy: number;
  sessions: SessionSummary[];
};

export type PromptUpdate = {
  type: "text" | "thought";
  text: string;
  messageId?: string;
};

export type PromptImage = {
  data: string;
  mimeType: "image/jpeg";
};

export type ModelSelection = {
  providerID: string;
  modelID: string;
};

export type PromptSettings = {
  agent: string;
  model: ModelSelection;
  variant?: string;
  system?: string;
};

export type ReplayMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

export type ModelOption = {
  id: string;
  name: string;
  model: ModelSelection;
};

export type ModelCatalog = {
  current?: ModelSelection;
  options: ModelOption[];
};

export type ControlRequest = {
  callerSessionId: string;
  callerMessageId: string;
  action: "list" | "status" | "read" | "attach" | "create";
  sessionId?: string;
  limit?: number;
  title?: string;
  expiresAt?: number;
};
