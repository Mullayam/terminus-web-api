import type { Client } from "ssh2";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export function execCapture(client: Client, command: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = "";
      let stderr = "";
      stream.on("data", (d: Buffer) => (stdout += d.toString("utf-8")));
      stream.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf-8")));
      stream.on("close", (code: number | null) => resolve({ stdout, stderr, code }));
    });
  });
}

export function sftpReadFile(client: Client, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.readFile(path, (e, data) => {
        if (e) return reject(e);
        resolve(data.toString("utf-8"));
      });
    });
  });
}

export function sftpWriteFile(client: Client, path: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.writeFile(path, content, (e) => (e ? reject(e) : resolve()));
    });
  });
}

export function sftpList(client: Client, path: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.readdir(path, (e, list) => {
        if (e) return reject(e);
        resolve(list.map((item) => item.longname));
      });
    });
  });
}
