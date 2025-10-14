export type RepoConfig = {
  frontend: {
    url: string;
    branch?: string;
    startCommand?: string;
    installCommand?: string;
    cwdName?: string;
    devUrl?: string;       // e.g., 'http://localhost:3000'
  };
  workspaceDir?: string;   // custom workspace directory, defaults to app.getPath('userData')/workspace
}
export type LaunchStatus = {
  step: 'idle' | 'checking-tools' | 'preparing' | 'cloning' | 'installing' | 'building' | 'starting' | 'running' | 'error';
  message?: string;
  logs?: string[];
  serverPid?: number | null;
  frontendPid?: number | null;
  server?: {
    step: 'idle' | 'preparing' | 'cloning' | 'installing' | 'building' | 'starting' | 'running' | 'error';
    message?: string;
  };
  client?: {
    step: 'idle' | 'preparing' | 'cloning' | 'installing' | 'building' | 'starting' | 'running' | 'error';
    message?: string;
  };
}