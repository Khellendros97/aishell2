import React from 'react';
import { Composition } from 'remotion';
import { SshDemo } from './SshDemo';
import { FileSftpDemo } from './FileSftpDemo';
import { AiModeDemo } from './AiModeDemo';
import { BrowserDemo } from './BrowserDemo';
import { StagingDemo } from './StagingDemo';
import { SshTunnelDemo } from './SshTunnelDemo';
import { CloudSyncDemo } from './CloudSyncDemo';
import { TimelineSyncDemo } from './TimelineSyncDemo';
import { IncentivePromo } from './IncentivePromo';
import { DashboardDemo } from './DashboardDemo';
import { Video } from './Video';
import { DURATION as BROWSER5_DURATION } from './browser5/script';
import { DURATION as STAGING6_DURATION } from './staging6/script';
import { DURATION as SSH7_DURATION } from './ssh7/script';
import { DURATION as CLOUD8_DURATION } from './cloud8/script';
import { DURATION as TL9_DURATION } from './timeline9/script';
import { DURATION as PROMO_DURATION } from './incentive-promo/script';
import { DURATION as DASH10_DURATION } from './dashboard10/script';

export const RemotionRoot: React.FC = () => (
  <>
    <Composition id="InitAiDemo" component={Video} durationInFrames={1240} fps={30} width={1920} height={1080} />
    <Composition id="ProjectSshDemo" component={SshDemo} durationInFrames={1800} fps={30} width={1920} height={1080} />
    <Composition id="FileSftpDemo" component={FileSftpDemo} durationInFrames={2560} fps={30} width={1920} height={1080} />
    <Composition id="AiModeDemo" component={AiModeDemo} durationInFrames={4300} fps={30} width={1920} height={1080} />
    <Composition id="BrowserDemo" component={BrowserDemo} durationInFrames={BROWSER5_DURATION} fps={30} width={1920} height={1080} />
    <Composition id="StagingDemo" component={StagingDemo} durationInFrames={STAGING6_DURATION} fps={30} width={1920} height={1080} />
    <Composition id="SshTunnelDemo" component={SshTunnelDemo} durationInFrames={SSH7_DURATION} fps={30} width={1920} height={1080} />
    <Composition id="CloudSyncDemo" component={CloudSyncDemo} durationInFrames={CLOUD8_DURATION} fps={30} width={1920} height={1080} />
    <Composition id="TimelineSyncDemo" component={TimelineSyncDemo} durationInFrames={TL9_DURATION} fps={30} width={1920} height={1080} />
    <Composition id="IncentivePromo" component={IncentivePromo} durationInFrames={PROMO_DURATION} fps={30} width={1920} height={1080} />
    <Composition id="DashboardDemo" component={DashboardDemo} durationInFrames={DASH10_DURATION} fps={30} width={1920} height={1080} />
  </>
);
