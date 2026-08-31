import React from 'react';
import { Composition } from 'remotion';
import { SshDemo } from './SshDemo';
import { FileSftpDemo } from './FileSftpDemo';
import { AiModeDemo } from './AiModeDemo';
import { Video } from './Video';

export const RemotionRoot: React.FC = () => (
  <>
    <Composition id="InitAiDemo" component={Video} durationInFrames={1240} fps={30} width={1920} height={1080} />
    <Composition id="ProjectSshDemo" component={SshDemo} durationInFrames={1800} fps={30} width={1920} height={1080} />
    <Composition id="FileSftpDemo" component={FileSftpDemo} durationInFrames={2560} fps={30} width={1920} height={1080} />
    <Composition id="AiModeDemo" component={AiModeDemo} durationInFrames={4300} fps={30} width={1920} height={1080} />
  </>
);
