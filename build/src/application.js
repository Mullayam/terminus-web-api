"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.bootstrap = void 0;
const http = __importStar(require("http"));
const morgan_1 = __importDefault(require("morgan"));
const helmet_1 = __importDefault(require("helmet"));
const cors_1 = __importDefault(require("cors"));
const logger_1 = require("@enjoys/express-utils/logger");
const body_parser_1 = __importDefault(require("body-parser"));
const colorette_1 = require("colorette");
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const exception_1 = require("@enjoys/exception");
const socket_1 = require("./services/socket");
const routes_resolver_1 = require("@enjoys/express-utils/routes-resolver");
const express_1 = __importDefault(require("express"));
const express_fileupload_1 = __importDefault(require("express-fileupload"));
const web_1 = __importDefault(require("./routes/web"));
const { ExceptionHandler, UnhandledRoutes } = (0, exception_1.createHandlers)();
class AppServer {
    constructor() {
        this.ApplyConfiguration();
        this.RegisterRoutes();
        this.ExceptionHandler();
        this.GracefulShutdown();
    }
    /**
     * Applies the necessary configurations to the AppServer.
     *
     * No parameters.
     *
     * @return {void} This function does not return anything.
     */
    ApplyConfiguration() {
        logger_1.Logging.dev("Applying Express Server Configurations");
        AppServer.App.use((0, helmet_1.default)());
        AppServer.App.disable('x-powered-by');
        AppServer.App.use((0, morgan_1.default)("dev"));
        AppServer.App.use((0, cookie_parser_1.default)());
        AppServer.App.use((0, cors_1.default)({
            origin: ["*"],
            optionsSuccessStatus: 200,
            methods: ["GET", "POST", "PUT", "DELETE"],
            allowedHeaders: ["Origin", "X-Requested-With", "Content-Type", "Accept", "Authorization", "Sessionid"],
            credentials: true
        }));
        AppServer.App.use(body_parser_1.default.json());
        AppServer.App.use((0, express_fileupload_1.default)());
        AppServer.App.use(body_parser_1.default.urlencoded({ extended: false }));
    }
    RegisterRoutes() {
        logger_1.Logging.dev("Registering Routes");
        logger_1.Logging.dev("Routes Registered");
        AppServer.App.use(web_1.default);
        AppServer.App.use(UnhandledRoutes);
        routes_resolver_1.RouteResolver.Mapper(AppServer.App, { listEndpoints: true, });
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
    ExceptionHandler() {
        logger_1.Logging.dev("Exception Handler Initiated");
        AppServer.App.use((err, req, res, next) => {
            if (err) {
                logger_1.Logging.dev(err.message, "error");
                return ExceptionHandler(err, req, res, next); // handler error and send response
            }
            next(); // call when no err found
        });
    }
    InitServer() {
        const server = http.createServer(AppServer.App).listen(AppServer.PORT, () => {
            console.log((0, colorette_1.blue)(`Application Started Successfully on  http://localhost:${AppServer.PORT}`));
        });
        (0, socket_1.InitSocketConnection)(server);
        server.on('close', () => {
            this.CloseServer(server);
        });
        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                logger_1.Logging.dev(`Address in use, retrying on port ${AppServer.PORT}`, "error");
            }
            else {
                console.log(`server.listen ERROR: ${err.code}`);
            }
        });
    }
    /**
        * Initializes the application.
    */
    InitailizeApplication() {
        logger_1.Logging.dev("Application Dependencies Injected");
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
            this.InitServer();
            return AppServer.App;
        }
        catch (error) {
            logger_1.Logging.dev(error.message, "error");
        }
    }
    GracefulShutdown() {
        process.on('SIGINT', () => {
            logger_1.Logging.dev("Manually Shutting Down", "notice");
            process.exit(1);
        });
        process.on('SIGTERM', () => {
            logger_1.Logging.dev("Error Occured", "error");
            process.exit(1);
        });
        process.on('uncaughtException', (err, origin) => {
            logger_1.Logging.dev(`Uncaught Exception ${err.name} ` + err.message + err.stack, "error");
            logger_1.Logging.dev(`Origin Of Error ${origin} `, "error");
        });
        process.on('unhandledRejection', (reason, promise) => {
            logger_1.Logging.dev(`Unhandled Rejection at ${promise}, reason: ${reason}`, "error");
        });
    }
    /**
    * Closes the given server and exits the process.
    *
    * @param {http.Server} server - The server to be closed.
    */
    CloseServer(server) {
        server.close(() => process.exit(1));
    }
}
AppServer.App = (0, express_1.default)();
AppServer.PORT = +7145;
exports.bootstrap = { AppServer: new AppServer(), express: express_1.default };
