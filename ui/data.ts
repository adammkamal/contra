import "server-only";
import { buildScreens } from "../src/view.ts";
import { getApp } from "./server.ts";

export const screens = () => buildScreens(getApp());
