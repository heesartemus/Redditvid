export const config = {
    runtime: 'edge',
};

export default async function handler(req) {
    const { searchParams } = new URL(req.url);
    const inputUrl = searchParams.get('url');

    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json',
    };

    if (!inputUrl) {
        return new Response(JSON.stringify({ error: 'No URL provided' }), { status: 400, headers });
    }

    try {
        // Step 1: Resolve the URL (follow redirects for short/share URLs)
        let postUrl = inputUrl.trim();
        
        // Follow redirects for redd.it and /s/ share links
        if (postUrl.match(/redd\.it/i) || postUrl.match(/reddit\.com\/r\/[^/]+\/s\//i)) {
            try {
                const r = await fetch(postUrl, {
                    redirect: 'follow',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    }
                });
                postUrl = r.url;
            } catch (e) {
                // Keep original URL if redirect fails
            }
        }

        // Step 2: Clean and normalize the URL
        postUrl = postUrl.split('?')[0].replace(/\/$/, '');

        // Remove tracking params and clean
        postUrl = postUrl.replace(/\/+$/, '');

        // Validate it looks like a Reddit post
        if (!postUrl.match(/reddit\.com\/r\//i) && !postUrl.match(/reddit\.com\/user\//i)) {
            return new Response(JSON.stringify({ error: 'This does not look like a Reddit post URL. Please copy the full URL from Reddit.' }), { status: 400, headers });
        }

        // Step 3: Try fetching JSON from old.reddit.com (more reliable)
        const oldRedditUrl = postUrl
            .replace('www.reddit.com', 'old.reddit.com')
            .replace('://reddit.com', '://old.reddit.com')
            .replace('://m.reddit.com', '://old.reddit.com');

        const jsonUrl = oldRedditUrl + '.json';

        const response = await fetch(jsonUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
            }
        });

        if (!response.ok) {
            // Fallback: try www.reddit.com
            const wwwJsonUrl = postUrl
                .replace('old.reddit.com', 'www.reddit.com')
                .replace('://reddit.com', '://www.reddit.com')
                .replace('://m.reddit.com', '://www.reddit.com')
                + '.json';

            const resp2 = await fetch(wwwJsonUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    'Accept': 'application/json',
                }
            });

            if (!resp2.ok) {
                return new Response(JSON.stringify({ 
                    error: 'Reddit returned status ' + resp2.status + '. The post may be private, deleted, or NSFW. Try a different post.' 
                }), { status: 400, headers });
            }

            const text2 = await resp2.text();
            return processRedditJson(text2, headers);
        }

        const text = await response.text();
        return processRedditJson(text, headers);

    } catch (err) {
        return new Response(JSON.stringify({ error: 'Server error: ' + (err.message || 'Unknown error') }), { status: 500, headers });
    }
}

function processRedditJson(text, headers) {
    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        return new Response(JSON.stringify({ error: 'Reddit did not return valid data. The URL may be incorrect.' }), { status: 400, headers });
    }

    // Extract post data
    let post;
    if (Array.isArray(data) && data[0]?.data?.children?.[0]?.data) {
        post = data[0].data.children[0].data;
    } else if (data?.data?.children?.[0]?.data) {
        post = data.data.children[0].data;
    }

    if (!post) {
        return new Response(JSON.stringify({ error: 'Could not find post data in Reddit response.' }), { status: 404, headers });
    }

    const title = post.title || 'Reddit Video';
    let videoUrl = null;
    let duration = null;

    // Method 1: post.media.reddit_video
    if (post.is_video && post.media?.reddit_video?.fallback_url) {
        videoUrl = post.media.reddit_video.fallback_url;
        duration = post.media.reddit_video.duration;
    }
    // Method 2: post.secure_media.reddit_video
    else if (post.is_video && post.secure_media?.reddit_video?.fallback_url) {
        videoUrl = post.secure_media.reddit_video.fallback_url;
        duration = post.secure_media.reddit_video.duration;
    }
    // Method 3: crosspost
    else if (post.crosspost_parent_list?.length > 0) {
        for (const cp of post.crosspost_parent_list) {
            const rv = cp.media?.reddit_video || cp.secure_media?.reddit_video;
            if (rv?.fallback_url) {
                videoUrl = rv.fallback_url;
                duration = rv.duration;
                break;
            }
        }
    }
    // Method 4: preview.reddit_video_preview
    else if (post.preview?.reddit_video_preview?.fallback_url) {
        videoUrl = post.preview.reddit_video_preview.fallback_url;
        duration = post.preview.reddit_video_preview.duration;
    }
    // Method 5: direct URL
    else if (post.url_overridden_by_dest) {
        const u = post.url_overridden_by_dest;
        if (u.match(/\.(mp4|webm)(\?|$)/i)) {
            videoUrl = u;
        } else if (u.match(/\.gifv$/i)) {
            videoUrl = u.replace('.gifv', '.mp4');
        } else if (u.includes('v.redd.it')) {
            videoUrl = u.endsWith('/') ? u + 'DASH_720.mp4' : u + '/DASH_720.mp4';
        }
    }
    // Method 6: media.oembed or other embed
    else if (post.url && post.url.includes('v.redd.it')) {
        videoUrl = post.url.endsWith('/') ? post.url + 'DASH_720.mp4' : post.url + '/DASH_720.mp4';
    }

    if (!videoUrl) {
        return new Response(JSON.stringify({ 
            error: 'No video found in this post. This tool works with Reddit-hosted videos (v.redd.it). The post may contain an image, text, or a link to an external site.' 
        }), { status: 404, headers });
    }

    // Clean video URL
    videoUrl = videoUrl.split('?')[0];

    // Build audio URL
    let audioUrl = null;
    if (videoUrl.includes('v.redd.it') && videoUrl.includes('DASH_')) {
        audioUrl = videoUrl.replace(/DASH_\d+\.mp4/, 'DASH_AUDIO_128.mp4');
    }

    return new Response(JSON.stringify({
        title,
        videoUrl,
        audioUrl,
        duration,
        hasAudio: !!audioUrl,
    }), { status: 200, headers });
}
