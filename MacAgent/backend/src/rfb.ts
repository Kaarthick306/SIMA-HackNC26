//Planning documentation
//Setting up VNC client for interaction
//need a way to read and write to client


import net from "node:net";
import { EventEmitter } from "node:events";
import { ARD_Response } from "./ARD_Auth.js";

const SEC_NONE = 1; //for no auth
const SEC_VNC = 2; //for VNC auth
const SEC_ARD = 30;

const ENC_RAW = 0; //for raw encoding
const ENC_COPYRECT = 1; //for copy rectangle encoding
const ENC_DESKTOPSIZE = -223; //for desktop size encoding

export interface RfbOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  timeoutMs?: number; //optional timeout in ms
}

