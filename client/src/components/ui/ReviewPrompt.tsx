import React, { useState } from "react";
import { api } from "../../api/client";
import { Button } from "./Button";

interface ReviewPromptProps {
  onDismiss: () => void;
}

export function ReviewPrompt({ onDismiss }: ReviewPromptProps) {
  const [rating, setRating] = useState(0);
  const [hoveredRating, setHoveredRating] = useState(0);
  const [comment, setComment] = useState("");
  const [userName, setUserName] = useState("");
  const [userTrade, setUserTrade] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (rating === 0) {
      setError("Please select a star rating");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.submitReview({
        rating,
        comment: comment.trim() || undefined,
        userName: userName.trim() || undefined,
        userTrade: userTrade.trim() || undefined,
      });
      setSubmitted(true);
    } catch (err: any) {
      setError(err?.apiError || err?.message || "Failed to submit review");
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="bg-brand-card border border-brand-border rounded-2xl p-5 mt-4">
        <div className="flex items-center gap-3">
          <span className="text-2xl">✓</span>
          <div>
            <p className="text-sm font-semibold text-brand-textPrimary">Thanks for your feedback!</p>
            <p className="text-xs text-brand-textSubtle">Your review will appear on our site once approved.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-brand-card border border-brand-border rounded-2xl p-5 mt-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <p className="text-sm font-semibold text-brand-textPrimary">How was your experience?</p>
          <p className="text-xs text-brand-textSubtle">Your feedback helps other contractors</p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-brand-textSubtle hover:text-brand-textMuted text-lg leading-none shrink-0"
        >
          ×
        </button>
      </div>

      <div className="flex gap-1 mb-3">
        {[1, 2, 3, 4, 5].map((star) => (
          <button
            key={star}
            type="button"
            onClick={() => setRating(star)}
            onMouseEnter={() => setHoveredRating(star)}
            onMouseLeave={() => setHoveredRating(0)}
            className="p-0.5 transition-transform hover:scale-110"
          >
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill={star <= (hoveredRating || rating) ? "currentColor" : "none"}
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={star <= (hoveredRating || rating) ? "text-yellow-400" : "text-brand-textSubtle"}
            >
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2 mb-2">
        <input
          type="text"
          placeholder="Your name (optional)"
          value={userName}
          onChange={(e) => setUserName(e.target.value)}
          maxLength={50}
          className="w-full rounded-lg bg-brand-bg border border-brand-border px-3 py-2 text-sm text-brand-textPrimary placeholder:text-brand-textSubtle focus:outline-none focus:ring-1 focus:ring-brand-indigo"
        />
        <input
          type="text"
          placeholder="Your trade (optional)"
          value={userTrade}
          onChange={(e) => setUserTrade(e.target.value)}
          maxLength={60}
          className="w-full rounded-lg bg-brand-bg border border-brand-border px-3 py-2 text-sm text-brand-textPrimary placeholder:text-brand-textSubtle focus:outline-none focus:ring-1 focus:ring-brand-indigo"
        />
      </div>

      <textarea
        placeholder="Share your experience (optional)"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        maxLength={500}
        rows={2}
        className="w-full rounded-lg bg-brand-bg border border-brand-border px-3 py-2 text-sm text-brand-textPrimary placeholder:text-brand-textSubtle focus:outline-none focus:ring-1 focus:ring-brand-indigo resize-none mb-3"
      />

      {error && <p className="text-xs text-red-400 mb-2">{error}</p>}

      <Button
        size="sm"
        onClick={handleSubmit}
        loading={submitting}
        disabled={rating === 0}
      >
        Submit Review
      </Button>
    </div>
  );
}
