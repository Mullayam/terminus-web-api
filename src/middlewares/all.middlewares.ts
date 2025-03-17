import { Logging } from '@enjoys/express-utils/logger';
import { Request, Response, NextFunction, RequestHandler } from 'express';
class AllMiddlewares {


    setHeaders(req: Request, res: Response, next: NextFunction) {

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-cache');
        res.header('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Origin', "*");
        res.setHeader('Access-Control-Allow-Headers', 'Origin,X-Requested-With,Content-Type,Accept,Authorization,x-app-version,x-app-name,x-api-key,Access-Control-Allow-Origin,Cache-Control');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS,PATCH');
        next();
    }
    /**
     * Middleware to protect API routes.
     * 
     * This middleware checks if the API request contains the required API key header.
     * If the key is not present or is invalid, it will return a 404 or 401 status code respectively.
     * If the key is valid, it will set the client secret to the API key and call the next middleware.
     * 
     * @param {Request} req - The request object.
     * @param {Response} res - The response object.
     * @param {NextFunction} next - The next middleware function.
     */
    public isApiProtected(req: Request, res: Response, next: NextFunction) {
        Logging.dev(`API Route ${req.originalUrl} is Protected`)
        const headers = req.headers;
        const apiKey = headers["api_key"] || undefined;
        if (typeof apiKey === "undefined") {
            res.status(404).json({
                success: false,
                result: {
                    code: 404
                },
                message: "API_KEY is Required",
            });
            res.end();
            return
        }
        if (apiKey !== process.env.API_KEY) {
            res.status(401).json({
                success: false,
                status_code: {
                    code: 412
                },
                message: "Invalid KEY, Check API KEY",
            });
            res.end();
            return
        }
        req.clientSecret = apiKey;
        next();

    }
    public IRequestHeaders(req: Request, res: Response, next: NextFunction) {
        Logging.dev("IRequestHeaders ID Initiated")
        const requestId = Math.random().toString(36).slice(2);
        req.headers['X-Request-Id'] = requestId;
        res.setHeader('X-Request-Id', requestId);
        res.setHeader('X-Platform', "AIRAPI - ENJOYS");
        next();
    }
    logResponseTime(req: Request, res: Response, next: NextFunction) {
        const startHrTime = process.hrtime();
        res.on("finish", () => {
            const elapsedHrTime = process.hrtime(startHrTime);
            const elapsedTimeInMs = elapsedHrTime[0] * 1000 + elapsedHrTime[1] / 1e6;
            console.log("%s %s %f in %fms", req.method, req.path, req.statusCode, elapsedTimeInMs.toFixed(4));
        });
        next();
    }
}


export function ApplyMiddleware(middlewareFunction: keyof AllMiddlewares): RequestHandler {
    const instance = new AllMiddlewares()
    return function (req: Request, res: Response, next: NextFunction) {
        return instance[middlewareFunction](req, res, next);
    };
}