import { spawn, spawnSync } from 'child_process'
import type { Response, Request } from 'express'
import { platform } from 'os'
class AuthController {
    async login(req: Request, res: Response) {
        try {
            res.json({
                status: true,
                message: 'Login Successful',
                result: {
                    token: 'your_jwt_token'
                }
            })

        } catch (err) {
            res.json({
                status: false,
                message: 'Login Successful',
                result: {
                    token: 'your_jwt_token'
                }
            })

        }
    }

    async register(req: Request, res: Response) {
        try {
            res.json({
                status: true,
                message: 'register Successful',
                result: {
                    token: 'your_jwt_token'
                }
            })

        } catch (err) {
            if (err instanceof Error) {
                res.json({
                    status: false,
                    message: err.message,
                    result: null
                })
            }
            res.json({
                status: false,
                message: "Something Went Wrong",
                result: null
            })

        }
    }
    async refresh(req: Request, res: Response) {
        try {
            res.json({
                status: true,
                message: 'refresh Successful',
                result: {}
            })

        } catch (err: any) {
            if (err instanceof Error) {
                res.json({
                    status: false,
                    message: err.message,
                    result: null
                })
            }
            res.json({
                status: false,
                message: "Something Went Wrong",
                result: null
            })

        }
    }
    async initTerminal(req: Request, res: Response) {
        try {
            let command: string | null = null;
            let args: string[] = [];
            const currDir = process.cwd();
            const currPlatform = platform();
            if (currPlatform === 'win32') {
                command = currDir + '/terminal.exe';
            } else if (currPlatform === 'linux') {
                command = currDir + '/terminal';
            }

            if (!command) {
                return res.status(400).json({
                    status: false,
                    message: 'Unsupported platform',
                    result: null
                });
            }

            // Ensure the Linux binary has execute permission
            if (currPlatform === 'linux') {
                await new Promise<void>((resolve, reject) => {
                    const chmod = spawn('sudo', ['chmod', '+x', command as string]);
                    chmod.on('close', (code) => (code === 0 ? resolve() : reject(new Error('Failed to chmod'))));
                });
            }

            // Spawn the process
            const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });

            let output = '';
            child.stdout?.on('data', (data) => {
                console.log(`stdout: ${data}`);
                output += data.toString();
            });

            child.stderr?.on('data', (data) => {
                console.error(`stderr: ${data}`);
            });

            child.on('close', (code) => {
                res.json({
                    status: true,
                    message: `Terminal exited with code ${code}`,
                    result: output
                });
            });

            child.on('error', (err) => {
                return res.status(500).json({
                    status: false,
                    message: err.message,
                    result: null
                });
            });

        } catch (err: any) {
            return res.status(500).json({
                status: false,
                message: err instanceof Error ? err.message : 'Something Went Wrong',
                result: null
            });
        }
    }
}
export default new AuthController()