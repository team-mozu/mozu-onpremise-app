
export type RepoConfig = {
  server: {
    url: string;           // Git repository URL for server
    branch?: string;       // Branch name (optional)
    startCommand?: string; // e.g., 'npm run start'
    installCommand?: string; // e.g., 'npm ci' or 'npm install'
    cwdName?: string;      // folder name to clone into
    dbPassword?: string;   // DB password for root user
  };
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
  step: 'idle' | 'checking-tools' | 'preparing' | 'cloning' | 'installing' | 'starting' | 'running' | 'error';
  message?: string;
  logs?: string[];
  serverPid?: number | null;
  frontendPid?: number | null;
}
