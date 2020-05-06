// Lamda handler 

/*             

                                                                                               
                                                                                               
                                                                                               
 Architecture
 _____________                                                                                              
                                                                                               
                                                                                               
                                            +-------------+      +-------------+               
                                         /- |  AWS API    |------|  Lambda     |               
   +                *.m3u8?starttime=* /-   |  Gateway    |      |  Handler    |               
                                    /--     +-------------+      +-------------+               
                                  /-                               --/                         
                                /-                              --/                            
+---------+             +----------+        +-------------+  --/   index.m3u8|sub_manifest.m3u8
| Client  |-------------|  Akamai  ---------|   VOD       |-/                                  
+---------+             +----------+        |   Origin    |                                    
                                \--         +-------------+                                    
                                   \--                                                         
                                      \--   +-------------+                                    
                                         \- |   Slide     |                                    
                                            |   Storage   |                                    
                                            +-------------+                                    



Manifest Manipulation Logic
---------------------------

 1) Scenario where elapsedTime < startTime (Segment needs to be from pre slide or pre slide countdown timer).
                                                                                                                                  
            liveWindowStartTime                         currentTime     startTime                                                   
                    |                                       |           |                                                          
       +------------+---+---+---+---+---+---+---+---+---+---|-----------+                                                        
       |            |PrS|PrS|PrS|PrS|PrS|PrS|PrS|PrS|PrS|PrS|           |         
       +------------+---+---+---+---+---+---+---+---+---+---+-----------+                                                                                                                 
                                                                        

 2) Scenario where (startTime + VOD duration ) > elapsedTime => startTime (Segment needs to be from VOD).

           liveWindowStartTime      startTime         currentTime                                                    
                    |                   |                   |                                                                   
       +------------+---+---+---+---+---+---+---+---+---+---|-----------+                                                        
       |            |PrS|PrS|PrS|PrS|PrS| X | X | X | X | X |   |   |   |         
       +------------+---+---+---+---+---+---+---+---+---+---+-----------+                                                        
                                                  
                      
 3) Scenario where elapsedTime => startTime (Segment needs to be from Post Slidee).

           liveWindowStartTime                         currentTime                                                
                    |                                       |                                                                   
       +------------+---+---+---+---+---+---+---+---+---+---|-----------+                                                        
                    | X | X | X | X | X | X |PoS|PoS|PoS|PoS|
       +------------+---+---+---+---+---+---+---+---+---+---+-----------+                                                        
                                               
*/

const http = require('http');
const HLS = require('hls-parser');

const DEBUG = (process.env.DEBUG == 'true') || true;
const countdown = Number(process.env.COUNTDOWN) || 1800;
const segmentLength = Number(process.env.SEGMENTLENGTH) || 6;
const epochstart = Number(process.env.EPOCHSTART) || 1588514400;
const preSlidePath = process.env.PRESLIDEPATH || "lte/ffademo/pre_slide";
const postSlidePath = process.env.POSTSLIDEPATH || "lte/ffademo/post_slide";
const countDownPath = process.env.COUNTDOWNPATH || "lte/ffademo/5mincount";
const preSlideSegments = Number(process.env.PRESLIDESEGMENTS) || 10;
const postSlideSegments = Number(process.env.POSTSLIDESEGMENTS) || 10;
const liveWindow = Number(process.env.LIVEWINDOW) || 60;
const domain = process.env.ORIGIN || 'http://vod1.syd2.vhe.telstra.com'
const slideDomain = process.env.SLIDEDOMAIN || 'http://lteborigin.vos.bigpond.com'


exports.handler = async (event, context) => {
    let body, resBody;
    let path = event.rawPath || event.path;
    let statusCode = '200';
    let headers;
    let starttime = event["queryStringParameters"]['starttime'];
    resBody = await get(domain + path);
    if (resBody && path.endsWith(".m3u8") && starttime ) {
        const playlist = HLS.parse(resBody);
        if (playlist.isMasterPlaylist) {
            if (starttime) {
                headers = {
                    'Content-Type': 'application/x-mpegURL',
                    'Cache-Control': 'max-age=86400'
                };
                body = injectQuery(resBody, `starttime=${starttime}`)
            }
        } else {
            headers = {
                'Content-Type': 'application/x-mpegURL',
                'Cache-Control': 'max-age=2'
            };
            let currentTime = Math.round(Date.now() / 1000)
            let startTime = Number(starttime)
            const regex = /([\/\w]+)\/([\w-]+.m3u8)/s;
            body = generatePlayList(playlist, startTime, currentTime, segmentLength, liveWindow, path.match(regex)[1]);
        }
    } else {
        statusCode = '400';
        body = "ERROR: Cannot get the m3u8"

    }

    return {
        statusCode,
        body,
        headers,
    };

};

function injectQuery(body, query) {

    var re = new RegExp('m3u8', 'g');
    var str = body.replace(re, `m3u8?${query}`);
    return str
}

const get = async (url) => {
    return new Promise((resolve, reject) => {
        http.get(url, res => {
            res.setEncoding('utf8');
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve(body));
        }).on('error', reject);
    });
};

function generatePlayList(playlist, startTime, currentTime, segmentLength, liveWindow, path) {
    let liveWindowStartTime = currentTime - liveWindow;
    let elapsedTime = 0;
    let outSegments = [];
    let discontinuityFound = false;
    const { MediaPlaylist, Segment } = HLS.types;

    let outplaylist = new MediaPlaylist({
        mediaSequenceBase: Math.floor((currentTime - epochstart) / segmentLength),
        targetDuration: segmentLength + 1,
        playlistType: 'LIVE',
    });


    while (elapsedTime < liveWindow) {
        // segment is before live event start time, preslide required.
/*

 1) Scenario where elapsedTime < startTime (Segment needs to be from pre slide or pre slide countdown timer).
                                                                                                                                  
            liveWindowStartTime                         currentTime     startTime                                                   
                    |                                       |           |                                                          
       +------------+---+---+---+---+---+---+---+---+---+---|-----------+                                                        
       |            |PrS|PrS|PrS|PrS|PrS|PrS|PrS|PrS|PrS|PrS|           |         
       +------------+---+---+---+---+---+---+---+---+---+---+-----------+                                                                                                                 
                                                                        
*/

        if (((liveWindowStartTime + elapsedTime) - startTime) < 0) {
            if (((liveWindowStartTime + elapsedTime) - startTime) < -countdown) {
                let segmentNo = Math.floor(((liveWindowStartTime + elapsedTime) - epochstart) / segmentLength % preSlideSegments)
                outSegments.push(new Segment({
                    uri: `${slideDomain}/${preSlidePath}/segment_${segmentNo}.ts`,
                    duration: segmentLength,
                    discontinuity: (segmentNo == 0)
                }))
            } else {
                let segmentNo = Math.floor(((((liveWindowStartTime + elapsedTime) - (startTime - countdown)) / segmentLength)) % (countdown / segmentLength))
                outSegments.push(new Segment({
                    uri: `${slideDomain}/${countDownPath}/segment_${segmentNo}.ts`,
                    duration: segmentLength,
                    discontinuity: (segmentNo == 0)
                }))
            }
        }
        // segment is after live event start time, post slide required.

    /*
        3) Scenario where elapsedTime => startTime (Segment needs to be from Post Slidee).

           liveWindowStartTime                         currentTime                                                
                    |                                       |                                                                   
       +------------+---+---+---+---+---+---+---+---+---+---|-----------+                                                        
                    | X | X | X | X | X | X |PoS|PoS|PoS|PoS|
       +------------+---+---+---+---+---+---+---+---+---+---+-----------+      
    */

        else if (Math.floor(((liveWindowStartTime + elapsedTime) - startTime) / segmentLength) > playlist.segments.length) {
            let segmentNo = Math.floor(((liveWindowStartTime + elapsedTime) - epochstart) / segmentLength % postSlideSegments)
            outSegments.push(new Segment({
                uri: `${slideDomain}/${postSlidePath}/segment_${segmentNo}.ts`,
                duration: segmentLength,
                discontinuity: discontinuityFound || (segmentNo == 0)
            }))
            discontinuityFound = false;

        }
        // segment is during live event start time, actual vod is required
/*
        2) Scenario where (startTime + VOD duration ) > elapsedTime => startTime (Segment needs to be from VOD).

           liveWindowStartTime      startTime         currentTime                                                    
                    |                   |                   |                                                                   
       +------------+---+---+---+---+---+---+---+---+---+---|-----------+                                                        
       |            |PrS|PrS|PrS|PrS|PrS| X | X | X | X | X |   |   |   |         
       +------------+---+---+---+---+---+---+---+---+---+---+-----------+                                                        
                                                     
    */
        else if (Math.floor(((liveWindowStartTime + elapsedTime) - startTime) / segmentLength) < playlist.segments.length) {
            let segmentNo = Math.floor(((liveWindowStartTime + elapsedTime) - startTime) / segmentLength)
            discontinuityFound = true;
            outSegments.push(new Segment({

                uri: `${domain}${path}/${playlist.segments[segmentNo].uri}`,
                duration: playlist.segments[segmentNo].duration,
                discontinuity: (segmentNo == 0)
            }))
        }
        elapsedTime += segmentLength;
    }
    outplaylist.segments = outSegments;
    return HLS.stringify(outplaylist);

}