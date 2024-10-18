import "dotenv/config"
import "reflect-metadata"
import { bootstrap } from "./src/application";
function main() {
    const app = bootstrap.AppServer.InitailizeApplication()!
    const options = {
        dotfiles: 'ignore',
        etag: false,
        extensions: ['htm', 'html'],
        index: false,
        maxAge: '1d',
        redirect: false,
        setHeaders(res: any, path: any, stat: any) {
            res.set('x-timestamp', Date.now())
        }
    }

    app.use(bootstrap.express.static('public', options))
}

main()