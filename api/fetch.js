export default async function handler(req, res) {
    const { url } = req.query;

    if (!url || (!url.includes('reddit.com') && !url.includes('redd.it'))) {
        return res.status(400).json({ error: 'Invalid Reddit URL' });
    }

    try {
        let finalUrl = url.split('?')[0];

        // Handle short redd.it URLs
        if (finalUrl.includes('redd.it')) {
            const resp = await fetch(finalUrl, { redirect: 'follow' });
            finalUrl = resp.url.split('?')[0];
        }

        // Fetch JSON from Reddit
        const jsonUrl = finalUrl.replace(/\/$/, '') + '.json';
        const response = await fetch(jsonUrl, {
            headers: {
                'User-Agent': 'RedditDown/1.0 (Video Downloader)',
            }
        });

        if (!response.ok) {
            return res.status(400).json({ error: 'Could not fetch Reddit post' });
        }

        const data = await response.json();
        const post = data?.[0]?.data?.children?.[0]?.data;

        if (!post) {
            return res.status(404).json({ error: 'Post not found' });
        }

        let videoUrl = null;
        let audioUrl = null;
        let title = post.title || 'Reddit Video';
        let duration = null;

        // Reddit-hosted video
        if (post.is_video && post.media?.reddit_video) {
            const rv = post.media.reddit_video;
            videoUrl = rv.fallback_url?.split('?')[0];
            duration = rv.duration;
            audioUrl = videoUrl.replace(/DASH_\d+\.mp4/, 'DASH_AUDIO_128.mp4');
        }
        // Crosspost video
        else if (post.crosspost_parent_list?.[0]?.media?.reddit_video) {
            const rv = post.crosspost_parent_list[0].media.reddit_video;
            videoUrl = rv.fallback_url?.split('?')[0];
            duration = rv.duration;
            audioUrl = videoUrl.replace(/DASH_\d+\.mp4/, 'DASH_AUDIO_128.mp4');
        }
        // Direct media link
        else if (post.url_overridden_by_dest?.match(/\.(mp4|gif)$/i)) {
            videoUrl = post.url_overridden_by_dest;
        }
        // Reddit gif/gifv
        else if (post.url_overridden_by_dest?.includes('.gifv')) {
            videoUrl = post.url_overridden_by_dest.replace('.gifv', '.mp4');
        }

        if (!videoUrl) {
            return res.status(404).json({ error: 'No downloadable video found in this post' });
        }

        // Check if audio exists
        let hasAudio = false;
        if (audioUrl) {
            try {
                const audioCheck = await fetch(audioUrl, { method: 'HEAD' });
                hasAudio = audioCheck.ok;
            } catch (e) {
                hasAudio = false;
            }
        }

        res.setHeader('Cache-Control', 's-maxage=300');
        return res.status(200).json({
            title,
            videoUrl,
            audioUrl: hasAudio ? audioUrl : null,
            duration,
            hasAudio
        });

    } catch (err) {
        return res.status(500).json({ error: 'Something went wrong: ' + err.message });
    }
}
