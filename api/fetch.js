const https = require('https');

module.exports = async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const inputUrl = req.query.url;
    if (!inputUrl) return res.status(400).json({ error: 'No URL provided' });

    try {
        let postUrl = inputUrl.trim();

        // Step 1: If short/share URL, resolve redirect
        if (postUrl.match(/redd\.it/i) || postUrl.match(/\/s\//i)) {
            postUrl = await resolveRedirect(postUrl);
        }

        // Step 2: Clean URL
        postUrl = postUrl.split('?')[0].replace(/\/+$/, '');
        postUrl = postUrl.replace(/\/\/old\.reddit/i, '//www.reddit');
        postUrl = postUrl.replace(/\/\/m\.reddit/i, '//www.reddit');
        if (postUrl.includes('reddit.com') && !postUrl.includes('www.reddit.com')) {
            postUrl = postUrl.replace('reddit.com', 'www.reddit.com');
        }

        // Step 3: Fetch JSON
        const jsonUrl = postUrl + '.json';
        let jsonData;
        try {
            jsonData = await httpGet(jsonUrl);
        } catch(fetchErr) {
            return res.status(400).json({ error: 'Failed to reach Reddit: ' + fetchErr.message });
        }

        let data;
        try {
            data = JSON.parse(jsonData);
        } catch(e) {
            // If Reddit returned HTML instead of JSON, try adding .json differently
            return res.status(400).json({ error: 'Reddit did not return JSON. The post may be private or NSFW.' });
        }

        // Step 4: Extract post
        let post;
        if (Array.isArray(data) && data[0] && data[0].data && data[0].data.children && data[0].data.children[0]) {
            post = data[0].data.children[0].data;
        } else if (data && data.data && data.data.children && data.data.children[0]) {
            post = data.data.children[0].data;
        }

        if (!post) return res.status(404).json({ error: 'No post data found in Reddit response.' });

        // Step 5: Find video
        const result = extractVideo(post);
        if (!result.videoUrl) {
            return res.status(404).json({ error: 'No Reddit video found. The post might be an image, text, GIF, or external link.' });
        }

        return res.status(200).json(result);

    } catch (err) {
        return res.status(500).json({ error: 'Server error: ' + (err.message || 'Unknown') });
    }
};

function extractVideo(post) {
    var videoUrl = null;
    var audioUrl = null;
    var duration = null;
    var title = post.title || 'Reddit Video';

    // Check all possible video locations
    var rv = null;

    // 1. media.reddit_video
    if (post.is_video && post.media && post.media.reddit_video) {
        rv = post.media.reddit_video;
    }
    // 2. secure_media.reddit_video
    if (!rv && post.is_video && post.secure_media && post.secure_media.reddit_video) {
        rv = post.secure_media.reddit_video;
    }
    // 3. crosspost
    if (!rv && post.crosspost_parent_list && post.crosspost_parent_list.length > 0) {
        for (var i = 0; i < post.crosspost_parent_list.length; i++) {
            var cp = post.crosspost_parent_list[i];
            if (cp.media && cp.media.reddit_video) { rv = cp.media.reddit_video; break; }
            if (cp.secure_media && cp.secure_media.reddit_video) { rv = cp.secure_media.reddit_video; break; }
        }
    }
    // 4. preview
    if (!rv && post.preview && post.preview.reddit_video_preview) {
        rv = post.preview.reddit_video_preview;
    }

    if (rv && rv.fallback_url) {
        videoUrl = rv.fallback_url.split('?')[0];
        duration = rv.duration;
    }

    // 5. Direct URL fallback
    if (!videoUrl && post.url_overridden_by_dest) {
        var u = post.url_overridden_by_dest;
        if (/\.(mp4|webm)(\?|$)/i.test(u)) videoUrl = u.split('?')[0];
        else if (/\.gifv$/i.test(u)) videoUrl = u.replace('.gifv', '.mp4');
        else if (u.indexOf('v.redd.it') !== -1) videoUrl = u.replace(/\/$/, '') + '/DASH_720.mp4';
    }

    // 6. post.url
    if (!videoUrl && post.url && post.url.indexOf('v.redd.it') !== -1) {
        videoUrl = post.url.replace(/\/$/, '') + '/DASH_720.mp4';
    }

    // Audio URL
    if (videoUrl && videoUrl.indexOf('DASH_') !== -1) {
        audioUrl = videoUrl.replace(/DASH_\d+\.mp4/, 'DASH_AUDIO_128.mp4');
    }

    return { title: title, videoUrl: videoUrl, audioUrl: audioUrl, duration: duration, hasAudio: !!audioUrl };
}

function httpGet(url) {
    return new Promise(function(resolve, reject) {
        var options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
            }
        };

        https.get(url, options, function(resp) {
            // Follow redirects (up to 5)
            if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
                var loc = resp.headers.location;
                if (loc.startsWith('/')) {
                    var parsed = new URL(url);
                    loc = parsed.protocol + '//' + parsed.host + loc;
                }
                return resolve(httpGet(loc));
            }

            if (resp.statusCode !== 200) {
                return reject(new Error('HTTP ' + resp.statusCode));
            }

            var data = '';
            resp.on('data', function(chunk) { data += chunk; });
            resp.on('end', function() { resolve(data); });
            resp.on('error', reject);
        }).on('error', reject);
    });
}

function resolveRedirect(url) {
    return new Promise(function(resolve) {
        if (!url.startsWith('http')) url = 'https://' + url;

        var parsed = new URL(url);
        var options = {
            hostname: parsed.hostname,
            path: parsed.pathname + parsed.search,
            method: 'HEAD',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            }
        };

        var req = https.request(options, function(resp) {
            if (resp.headers.location) {
                resolve(resp.headers.location);
            } else {
                resolve(url);
            }
        });
        req.on('error', function() { resolve(url); });
        req.end();
    });
}
