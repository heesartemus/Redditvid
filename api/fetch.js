export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'No URL provided' });

    try {
        let postUrl = url.trim();

        // Follow redirects for short URLs (redd.it, reddit.com/r/sub/s/...)
        if (postUrl.match(/redd\.it\//i) || postUrl.match(/\/s\//i)) {
            try {
                const r = await fetch(postUrl, { 
                    redirect: 'manual',
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
                });
                const loc = r.headers.get('location');
                if (loc) postUrl = loc;
            } catch(e) {}
        }

        // Clean URL
        postUrl = postUrl.split('?')[0].replace(/\/$/, '');

        // Normalize domain
        postUrl = postUrl.replace(/\/\/old\.reddit\.com/i, '//www.reddit.com');
        postUrl = postUrl.replace(/\/\/m\.reddit\.com/i, '//www.reddit.com');
        if (!postUrl.includes('www.reddit.com') && postUrl.includes('reddit.com')) {
            postUrl = postUrl.replace('reddit.com', 'www.reddit.com');
        }

        // Fetch JSON
        const jsonUrl = postUrl + '.json';
        const response = await fetch(jsonUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json',
            }
        });

        if (!response.ok) {
            // Fallback: try HTML meta tags
            const htmlResp = await fetch(postUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
            });
            const html = await htmlResp.text();
            const ogVideo = html.match(/og:video:secure_url"\s*content="([^"]+)"/i) || html.match(/og:video"\s*content="([^"]+)"/i);
            const ogTitle = html.match(/<title>([^<]+)<\/title>/i);

            if (ogVideo) {
                return res.status(200).json({
                    title: ogTitle ? ogTitle[1].replace(/ : reddit/i, '').trim() : 'Reddit Video',
                    videoUrl: ogVideo[1],
                    audioUrl: null,
                    hasAudio: false,
                    duration: null
                });
            }
            return res.status(400).json({ error: 'Could not access this Reddit post. It may be private, deleted, or not contain a video.' });
        }

        let data;
        try {
            data = JSON.parse(await response.text());
        } catch(e) {
            return res.status(400).json({ error: 'Reddit returned invalid data.' });
        }

        let post;
        if (Array.isArray(data)) {
            post = data[0]?.data?.children?.[0]?.data;
        } else if (data?.data?.children) {
            post = data.data.children[0]?.data;
        }

        if (!post) return res.status(404).json({ error: 'Could not find post data.' });

        let videoUrl = null;
        let audioUrl = null;
        let title = post.title || 'Reddit Video';
        let duration = null;

        // 1. Reddit video
        const rv = post.media?.reddit_video || post.secure_media?.reddit_video;
        if (post.is_video && rv) {
            videoUrl = rv.fallback_url || rv.scrubber_media_url;
            duration = rv.duration;
        }
        // 2. Crosspost
        else if (post.crosspost_parent_list?.length > 0) {
            const cp = post.crosspost_parent_list[0];
            const crv = cp.media?.reddit_video || cp.secure_media?.reddit_video;
            if (cp.is_video && crv) {
                videoUrl = crv.fallback_url || crv.scrubber_media_url;
                duration = crv.duration;
            }
        }
        // 3. Preview video
        else if (post.preview?.reddit_video_preview) {
            const pv = post.preview.reddit_video_preview;
            videoUrl = pv.fallback_url || pv.scrubber_media_url;
            duration = pv.duration;
        }
        // 4. Direct link
        else if (post.url_overridden_by_dest) {
            const d = post.url_overridden_by_dest;
            if (d.match(/\.(mp4|webm)(\?|$)/i)) videoUrl = d;
            else if (d.match(/\.gifv$/i)) videoUrl = d.replace('.gifv', '.mp4');
            else if (d.includes('v.redd.it')) videoUrl = d + '/DASH_720.mp4';
        }

        if (!videoUrl) return res.status(404).json({ error: 'No video found in this post. Make sure the post contains a Reddit-hosted video.' });

        videoUrl = videoUrl.split('?')[0];

        // Find audio
        let hasAudio = false;
        if (videoUrl.includes('v.redd.it') && videoUrl.includes('DASH_')) {
            const tryAudios = [
                videoUrl.replace(/DASH_\d+\.mp4/, 'DASH_AUDIO_128.mp4'),
                videoUrl.replace(/DASH_\d+\.mp4/, 'DASH_audio.mp4'),
                videoUrl.replace(/DASH_\d+\.mp4/, 'DASH_AUDIO_64.mp4'),
                videoUrl.replace(/DASH_\d+\.mp4/, 'audio'),
            ];
            for (const tryUrl of tryAudios) {
                try {
                    const check = await fetch(tryUrl, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0' } });
                    if (check.ok) { audioUrl = tryUrl; hasAudio = true; break; }
                } catch(e) {}
            }
        }

        return res.status(200).json({ title, videoUrl, audioUrl, duration, hasAudio });

    } catch (err) {
        return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
}
