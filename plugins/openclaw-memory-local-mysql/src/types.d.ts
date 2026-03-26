// OpenClaw Plugin SDK 类型声明
declare module 'openclaw/plugin-sdk' {
  export interface OpenClawPluginApi {
    pluginConfig: any;
    logger: {
      info: (msg: string, ...args: any[]) => void;
      error: (msg: string, ...args: any[]) => void;
      warn: (msg: string, ...args: any[]) => void;
    };
    registerTool: (tool: any, binding?: any) => void;
    on: (event: string, handler: Function) => void;
  }

  export interface HookEvent {
    messages?: any[];
  }

  export interface HookContext {
    agentId?: string;
    projectId?: string;
    sessionKey?: string;
  }
}
