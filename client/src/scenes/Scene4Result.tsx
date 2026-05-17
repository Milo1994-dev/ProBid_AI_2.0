import React from 'react';
import { motion } from 'framer-motion';
import { HardHat, MapPin, Activity } from 'lucide-react';

const LEADS = [
  { name: "Apex Roofing Co.", trade: "Roofing", city: "Chicago, IL", time: "0ms" },
  { name: "Solid Concrete Bros", trade: "Concrete", city: "Milwaukee, WI", time: "124ms" },
  { name: "Detroit Masonry Works", trade: "Masonry", city: "Detroit, MI", time: "248ms" },
  { name: "Lakeside Build Pros", trade: "General", city: "Gary, IN", time: "412ms" },
  { name: "Steel Frameworks Ltd", trade: "Steel", city: "Peoria, IL", time: "560ms" },
];

export default function Scene4Result() {
  return (
    <motion.div 
      className="absolute inset-0 flex flex-col bg-brand-bg"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, filter: "blur(20px)" }}
      transition={{ duration: 1 }}
    >
      
      {/* Dashboard Top Bar */}
      <motion.div 
        className="w-full h-16 border-b border-brand-border bg-brand-card flex items-center justify-between px-8"
        initial={{ y: -50, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.5, duration: 0.6 }}
      >
        <div className="font-display font-bold text-xl flex items-center gap-2">
          <Activity className="text-brand-primary" />
          <span>LEAD_STREAM_ACTIVE</span>
        </div>
        <div className="font-mono text-sm flex gap-6">
          <span className="text-brand-primary flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-brand-primary animate-pulse" />
            LIVE
          </span>
          <span className="text-brand-muted">CATCH-UP: SUCCESS</span>
        </div>
      </motion.div>

      <div className="flex-1 flex px-8 py-8 gap-8 overflow-hidden">
        
        {/* Left Col: The Stream */}
        <div className="w-2/3 flex flex-col gap-4 relative">
          
          <motion.div 
            className="absolute top-0 bottom-0 left-8 w-px bg-brand-primary/20"
            initial={{ height: 0 }}
            animate={{ height: '100%' }}
            transition={{ delay: 1, duration: 2 }}
          />

          {LEADS.map((lead, i) => (
            <motion.div 
              key={i}
              className="ml-16 bg-brand-card border border-brand-border p-5 rounded-lg flex items-center justify-between relative shadow-lg"
              initial={{ x: -50, opacity: 0, scale: 0.95 }}
              animate={{ x: 0, opacity: 1, scale: 1 }}
              transition={{ delay: 1.5 + (i * 0.4), type: "spring", stiffness: 300, damping: 25 }}
            >
              {/* Timeline dot */}
              <div className="absolute -left-[32.5px] top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-brand-bg border-2 border-brand-primary" />
              
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded bg-brand-primary/10 flex items-center justify-center text-brand-primary">
                  <HardHat size={20} />
                </div>
                <div>
                  <h3 className="font-display font-bold text-lg">{lead.name}</h3>
                  <div className="flex gap-4 font-mono text-xs text-brand-muted mt-1">
                    <span className="px-2 py-0.5 bg-brand-bg rounded border border-brand-border">{lead.trade}</span>
                    <span className="flex items-center gap-1"><MapPin size={12}/> {lead.city}</span>
                  </div>
                </div>
              </div>

              <div className="font-mono text-xs text-brand-primary/60 text-right">
                <div>+ {lead.time}</div>
                <div>IMPORTED</div>
              </div>
            </motion.div>
          ))}
        </div>

        {/* Right Col: Grand Total & Logo */}
        <div className="w-1/3 flex flex-col justify-center items-center gap-12">
          
          <motion.div 
            className="text-center"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 4, duration: 1 }}
          >
            <div className="font-mono text-brand-muted mb-2">PIPELINE RESTORED</div>
            <motion.div 
              className="text-7xl font-display font-bold text-white text-glow"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 4.5, duration: 2 }}
            >
              100%
            </motion.div>
            <div className="font-mono text-brand-primary mt-2">Zero Lost Time</div>
          </motion.div>

          <motion.div 
            className="flex flex-col items-center mt-12"
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 6, duration: 1, type: "spring" }}
          >
            <div className="text-3xl font-display font-bold flex items-center gap-2">
              ProBid AI
              <Activity className="text-brand-primary w-8 h-8" />
            </div>
          </motion.div>

        </div>

      </div>

      {/* Screen flash effect */}
      <motion.div 
        className="absolute inset-0 bg-brand-primary pointer-events-none mix-blend-overlay"
        initial={{ opacity: 0 }}
        animate={{ opacity: [0, 0.1, 0] }}
        transition={{ delay: 8, duration: 2 }}
      />
    </motion.div>
  );
}