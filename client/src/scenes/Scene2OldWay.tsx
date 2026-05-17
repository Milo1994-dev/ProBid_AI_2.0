import React from 'react';
import { motion } from 'framer-motion';

export default function Scene2OldWay() {
  // Generate 24 hour blocks
  const hours = Array.from({ length: 24 }, (_, i) => i);

  return (
    <motion.div 
      className="absolute inset-0 flex flex-col items-center justify-center"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, x: -100 }}
      transition={{ duration: 0.8 }}
    >
      <div className="w-[80vw] max-w-5xl h-[60vh] flex flex-col justify-center gap-12">
        
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
        >
          <h2 className="font-display text-4xl text-brand-muted">THE OLD WAY:</h2>
          <h1 className="font-display text-6xl font-bold mt-2">The 24-Hour Wait</h1>
        </motion.div>

        <div className="flex flex-wrap gap-2 w-full">
          {hours.map((hour, i) => (
            <motion.div
              key={hour}
              className={`flex-1 h-16 rounded flex items-center justify-center border ${
                hour === 0 ? 'bg-brand-error/20 border-brand-error text-brand-error' : 
                hour === 23 ? 'bg-brand-primary/20 border-brand-primary text-brand-primary' : 
                'bg-brand-card border-brand-border/30 text-brand-muted/30'
              }`}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.8 + (i * 0.05), duration: 0.3 }}
            >
              <span className="font-mono text-xs">
                {hour === 0 ? '08:00' : hour === 23 ? '08:00' : ''}
              </span>
            </motion.div>
          ))}
        </div>

        <motion.div 
          className="flex justify-between items-center w-full px-2"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 2.5 }}
        >
          <div className="font-mono text-brand-error flex flex-col">
            <span className="text-xl font-bold">MISSED</span>
            <span className="text-sm">Server offline</span>
          </div>

          <motion.div 
            className="h-px bg-gradient-to-r from-brand-error via-brand-muted/30 to-brand-primary flex-1 mx-8 relative"
            initial={{ scaleX: 0, transformOrigin: "left" }}
            animate={{ scaleX: 1 }}
            transition={{ delay: 2.8, duration: 1.5, ease: "linear" }}
          >
            <motion.div 
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-brand-bg px-4 text-brand-muted font-mono"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 3.5 }}
            >
              24 HOURS WASTED • 0 LEADS
            </motion.div>
          </motion.div>

          <div className="font-mono text-brand-primary flex flex-col text-right">
            <span className="text-xl font-bold">NEXT TRY</span>
            <span className="text-sm">Tomorrow</span>
          </div>
        </motion.div>

      </div>
    </motion.div>
  );
}