import React, { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Layout } from "../components/layout/Layout";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Alert } from "../components/ui/Alert";
import { api } from "../api/client";
import { usePageMeta } from "../hooks/usePageMeta";

const TRADES = [
  "Masonry", "Roofing", "Concrete", "Remodeling", "HVAC", "Electrical",
  "Plumbing", "Landscaping", "Painting", "Flooring", "Drywall", "Tuckpointing",
];

interface SocialPost {
  platform: string;
  title?: string;
  body: string;
  tip: string;
}

function PlatformIcon({ platform }: { platform: string }) {
  if (platform === "Reddit") return <span className="text-[#FF4500]">●</span>;
  if (platform === "Facebook") return <span className="text-[#1877F2]">●</span>;
  if (platform === "LinkedIn") return <span className="text-[#0A66C2]">●</span>;
  if (platform === "Nextdoor") return <span className="text-[#8BC34A]">●</span>;
  return <span className="text-brand-textMuted">●</span>;
}

function PostCard({ post }: { post: SocialPost }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    const text = post.title ? `${post.title}\n\n${post.body}` : post.body;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <PlatformIcon platform={post.platform} />
          <span className="font-bold text-brand-textPrimary text-sm">{post.platform}</span>
        </div>
        <Button variant="ghost" size="sm" onClick={handleCopy}>
          {copied ? "Copied!" : "Copy"}
        </Button>
      </div>

      {post.title && (
        <p className="font-semibold text-brand-textPrimary text-sm">{post.title}</p>
      )}
      <p className="text-brand-textMuted text-sm leading-relaxed whitespace-pre-wrap">{post.body}</p>

      <div className="flex items-start gap-2 bg-brand-indigo/5 border border-brand-indigo/20 rounded-lg p-3 mt-1">
        <span className="text-brand-indigo text-xs font-bold shrink-0">TIP</span>
        <p className="text-xs text-brand-textMuted">{post.tip}</p>
      </div>
    </Card>
  );
}

export default function SocialPage() {
  usePageMeta({
    title: "Social Content | ProBid AI",
    description: "Generate ready-to-post contractor content for Reddit, Facebook groups, and more.",
    canonical: "https://probidcore.net/app/social",
  });

  const [trade, setTrade] = useState("Masonry");
  const [city, setCity] = useState("");
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [error, setError] = useState("");

  const generateMutation = useMutation({
    mutationFn: () => api.generateSocialPosts({ trade, city: city.trim() }),
    onSuccess: (res) => {
      setPosts(res.data?.posts ?? []);
      setError("");
    },
    onError: (err: any) => {
      setError(err?.apiError ?? "Failed to generate content. Try again.");
    },
  });

  return (
    <Layout>
      <div className="max-w-2xl mx-auto">
        <h1 className="text-3xl font-black text-brand-textPrimary mb-2">Social Traffic</h1>
        <p className="text-brand-textMuted mb-2">
          Generate ready-to-post content for Reddit, Facebook contractor groups, Nextdoor, and LinkedIn.
          Copy, paste, and drive free traffic to your ProBid page.
        </p>
        <p className="text-xs text-brand-textMuted mb-8 italic">
          Each batch is AI-written to feel authentic — vary the post or add your own spin before posting.
        </p>

        {error && <Alert type="error" className="mb-6" onDismiss={() => setError("")}>{error}</Alert>}

        {/* Config */}
        <Card className="mb-6">
          <h2 className="text-base font-bold text-brand-textPrimary mb-4">Generate Content</h2>
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="flex-1">
              <label className="text-xs font-semibold text-brand-textMuted block mb-1">Your Trade</label>
              <select
                value={trade}
                onChange={(e) => setTrade(e.target.value)}
                className="w-full bg-brand-card border border-brand-border rounded-xl px-3 py-2.5 text-sm text-brand-textPrimary focus:outline-none focus:border-brand-indigo"
              >
                {TRADES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <label className="text-xs font-semibold text-brand-textMuted block mb-1">City / Region <span className="text-brand-textSubtle">(optional)</span></label>
              <input
                type="text"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="e.g. Chicago, Austin, Dallas..."
                className="w-full bg-brand-card border border-brand-border rounded-xl px-3 py-2.5 text-sm text-brand-textPrimary placeholder:text-brand-textMuted focus:outline-none focus:border-brand-indigo"
              />
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <Button
              onClick={() => generateMutation.mutate()}
              loading={generateMutation.isPending}
            >
              {generateMutation.isPending ? "Generating..." : "Generate Posts"}
            </Button>
          </div>
        </Card>

        {/* Posts */}
        {posts.length > 0 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold text-brand-textPrimary">Your Posts</h2>
              <Button variant="ghost" size="sm" onClick={() => generateMutation.mutate()} loading={generateMutation.isPending}>
                Regenerate
              </Button>
            </div>
            {posts.map((post, i) => (
              <PostCard key={i} post={post} />
            ))}
            <p className="text-xs text-center text-brand-textMuted pt-2">
              Post 1–2× per week in relevant groups. Authenticity beats volume.
            </p>
          </div>
        )}

        {/* Empty state before generation */}
        {posts.length === 0 && !generateMutation.isPending && (
          <div className="text-center py-12 text-brand-textMuted">
            <div className="text-4xl mb-4">✍️</div>
            <p className="text-sm">Select your trade and click <strong className="text-brand-textPrimary">Generate Posts</strong> to get ready-to-use content for 4 platforms.</p>
          </div>
        )}
      </div>
    </Layout>
  );
}
