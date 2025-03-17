import * as http from 'http'
import morgan from 'morgan'
import helmet from 'helmet';
import cors from 'cors'
import { Logging } from '@enjoys/express-utils/logger';
import bodyParser from 'body-parser';
import { blue } from 'colorette';
import cookieParser from 'cookie-parser';
import { createHandlers } from '@enjoys/exception';
import { InitSocketConnection } from './services/socket';
import { RouteResolver } from '@enjoys/express-utils/routes-resolver';
import express, { Application, NextFunction, Response, Request } from 'express'
import fileUpload from 'express-fileupload';
import ApiRoutes from './routes/web'
import { ApplyMiddleware } from './middlewares/all.middlewares';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { Socket } from 'net';
const { ExceptionHandler, UnhandledRoutes } = createHandlers();

class AppServer {
    static App: Application = express();
    static PORT: number = +7145;

    constructor() {
        AppServer.App.use(ApplyMiddleware("setHeaders"));
        this.ApplyConfiguration();
        this.RegisterRoutes();
        this.ExceptionHandler();
        this.GracefulShutdown()
    }
    private handleWebSocketProxy(server: http.Server) {
        const webSocketProxy = createProxyMiddleware({
            target: 'http://localhost:7555',
           changeOrigin: true,
            pathRewrite: { '^/ws': '/' },
            ws: true,
            logger: console.log,
            on: {
                proxyReqWs: (proxyReq, req, socket, options) => {
                    Logging.dev(`Proxying WebSocket request for ${req.url}`);
                }
            }
        });
        server.on('upgrade', (req, socket, head) => {
            if (req.url?.startsWith('/ws')) {
                webSocketProxy.upgrade(req, socket as Socket, head);
            }
        });
        return (req: Request, res: Response, next: NextFunction) => {
            return webSocketProxy(req, res, next);
        };
    }
    /**
     * Applies the necessary configurations to the AppServer.
     *
     * No parameters.
     * 
     * @return {void} This function does not return anything.
     */
    private ApplyConfiguration() {
        Logging.dev("Applying Express Server Configurations")
        AppServer.App.use(helmet());
        AppServer.App.disable('x-powered-by');
        AppServer.App.use(morgan("dev"));
        AppServer.App.use(cookieParser());
        AppServer.App.use(cors({
            origin: "*",
            optionsSuccessStatus: 200,
            methods: ["GET", "POST", "PUT", "DELETE"],
            allowedHeaders: ["Origin", "X-Requested-With", "Content-Type", "Accept", "Authorization", "Sessionid"],
            credentials: true
        }));
        AppServer.App.use(bodyParser.json());
        AppServer.App.use(fileUpload({
            useTempFiles: true,
            tempFileDir: '/tmp/',
        }));
        AppServer.App.set('timeout', 0)
        AppServer.App.use(bodyParser.urlencoded({ extended: false }));
    }
    private RegisterRoutes() {
        Logging.dev("Registering Routes")
        Logging.dev("Routes Registered")
        AppServer.App.use(ApiRoutes);
        AppServer.App.use(UnhandledRoutes);
        RouteResolver.Mapper(AppServer.App, { listEndpoints: true, })
    }
    /**
        * ExceptionHandler function.
        *
        * @param {Error} err - The error that occurred.
        * @param {Request} req - The request object.
        * @param {Response} res - The response object.
        * @param {NextFunction} next - The next function to call.
        * @return {void} There is no return value.
        */

    private ExceptionHandler() {
        Logging.dev("Exception Handler Initiated")
        AppServer.App.use((err: Error, req: Request, res: Response, next: NextFunction) => {
            if (err) {
                Logging.dev(err.message, "error")
                return ExceptionHandler(err, req, res, next); // handler error and send response
            }
            next(); // call when no err found
        });

    }
    private InitServer() {
        const server = http.createServer(AppServer.App).listen(AppServer.PORT, () => {
            console.log(blue(`Application Started Successfully on  http://localhost:${AppServer.PORT}`),)
        })
        InitSocketConnection(server)

        AppServer.App.use(this.handleWebSocketProxy(server))
        server.on('close', () => {
            this.CloseServer(server)
        })
        server.on('error', (err: any) => {
            if (err.code === 'EADDRINUSE') {
                Logging.dev(`Address in use, retrying on port ${AppServer.PORT}`, "error");
            } else {
                console.log(`server.listen ERROR: ${err.code}`);
            }
        })
    }
    /**
        * Initializes the application. 
    */
    InitailizeApplication() {
        Logging.dev("Application Dependencies Injected")
        try {
            /** NOTE  Enable Database Connection
             * Using InjectRepository Decorator first Db Connection must be initialized otherwise it will throw error that {repository} is undefined
                *  CreateConnection()
                .then(() => this.InitServer())
                .catch(error => {
                    Logging.dev(error )
                    process.exit(1)
                })   
             */
            this.InitServer()
            return AppServer.App

        } catch (error: any) {
            Logging.dev(error.message, "error")
        }
    }
    private GracefulShutdown() {
        process.on('SIGINT', () => {
            Logging.dev("Manually Shutting Down", "notice")

            process.exit(1);
        })
        process.on('SIGTERM', () => {
            Logging.dev("Error Occured", "error")

            process.exit(1);
        })
        process.on('uncaughtException', (err, origin) => {
            Logging.dev(`Uncaught Exception ${err.name} ` + err.message + err.stack, "error")
            Logging.dev(`Origin Of Error ${origin} `, "error")

        });
        process.on('unhandledRejection', (reason, promise) => {
            Logging.dev(`Unhandled Rejection at ${promise}, reason: ${reason}`, "error")
        });
    }

    /**
    * Closes the given server and exits the process.
    *
    * @param {http.Server} server - The server to be closed.
    */
    private CloseServer(server: http.Server) {
        server.close(() => process.exit(1));
    }
}
export const bootstrap = { AppServer: new AppServer(), express }