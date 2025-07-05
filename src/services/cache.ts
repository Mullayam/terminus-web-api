import { __CONFIG__ } from "@/utils/constant";
import { Logging } from "@enjoys/express-utils/logger";
import { createClient } from "redis";
 
const client = createClient({ url: __CONFIG__.REDIS_URL })

client.connect().then(() => Logging.dev(`Publisher Connected Successfully`)).catch((error: any) => Logging.dev(`Error : ${error}`, "error"));

export const publisher = client
const subscriberClient = client.duplicate()
subscriberClient.connect().then(() => Logging.dev(`Subscriber Connected Successfully`)).catch((error: any) => Logging.dev(`Error : ${error}`, "error"));
export const subscriber = subscriberClient