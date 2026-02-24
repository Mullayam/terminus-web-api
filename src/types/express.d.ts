import 'express';

declare global {
    namespace Express {
        interface Request {
            clientSecret?: string;
        }
    }
}
