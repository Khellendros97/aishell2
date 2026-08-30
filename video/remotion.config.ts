import { Config } from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setOverwriteOutput(true);
// Windows 下 ANGLE 渲染更稳
Config.setChromiumOpenGlRenderer('angle');
