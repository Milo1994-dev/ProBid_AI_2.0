import React from 'react';
import { motion } from 'framer-motion';
import { Power, CheckCircle2, Zap } from 'lucide-react';

export default function Scene3Fix() {
  return (
    <motion.div 
      className="absolute inset-0 flex flex-col items-center justify-center bg-[#0a0e1a]"
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, y: -50 }}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="w-[80vw] max-w-5xl h-[70vh] flex flex-col relative">
        
        <motion.div 
          className="text-center mt-10 mb-16"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5 }}
        >
          <h2 className="font-display text-brand-primary text-2xl font-bold tracking-widest uppercase text-glow">Startup Catch-Up</h2>
          <h1 className="font-display text-5xl font-bold mt-2">The ProBid AI Fix</h1>
        </motion.div>

        {/* Flowchart container */}
        <div className="flex-1 relative flex items-center justify-center">
          
          {/* Node 1: Server Restart */}
          <motion.div 
            className="absolute left-[10%] flex flex-col items-center z-10"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 1, type: "spring" }}
          >
            <div className="w-20 h-20 rounded-full bg-brand-card border-2 border-brand-primary flex items-center justify-center shadow-[0_0_30px_rgba(34,197,94,0.3)]">
              <Power className="w-8 h-8 text-brand-primary" />
            </div>
            <div className="mt-4 font-mono text-sm text-center">
              SYSTEM<br/>RESTART
            </div>
          </motion.div>

          {/* Connection 1 */}
          <motion.div 
            className="absolute left-[20%] w-[20%] h-px bg-brand-border"
            initial={{ scaleX: 0, transformOrigin: "left" }}
            animate={{ scaleX: 1 }}
            transition={{ delay: 1.5, duration: 0.5 }}
          />
          <motion.div 
            className="absolute left-[20%] w-[20%] h-px bg-brand-primary shadow-[0_0_10px_rgba(34,197,94,0.8)]"
            initial={{ scaleX: 0, transformOrigin: "left" }}
            animate={{ scaleX: 1 }}
            transition={{ delay: 1.5, duration: 0.5 }}
          />

          {/* Node 2: Logic Check */}
          <motion.div 
            className="absolute left-[40%] flex flex-col items-center z-10"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 2, type: "spring" }}
          >
            <div className="p-4 bg-brand-card border border-brand-border rounded-lg shadow-xl relative overflow-hidden">
              <motion.div 
                className="absolute inset-0 bg-brand-primary/10"
                animate={{ opacity: [0, 1, 0] }}
                transition={{ delay: 2.2, duration: 1, repeat: 2 }}
              />
              <div className="font-mono text-sm space-y-2">
                <div><span className="text-brand-muted">if</span> (!scraperRunToday) {'{'}</div>
                <motion.div 
                  className="pl-4 text-brand-primary font-bold flex items-center gap-2"
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 3 }}
                >
                  <Zap className="w-4 h-4" /> runNow();
                </motion.div>
                <div>{'}'}</div>
              </div>
            </div>
          </motion.div>

          {/* Connection 2 */}
          <motion.div 
            className="absolute left-[65%] w-[15%] h-px bg-brand-border"
            initial={{ scaleX: 0, transformOrigin: "left" }}
            animate={{ scaleX: 1 }}
            transition={{ delay: 3.5, duration: 0.5 }}
          />
           <motion.div 
            className="absolute left-[65%] w-[15%] h-[2px] bg-brand-primary shadow-[0_0_15px_rgba(34,197,94,1)]"
            initial={{ scaleX: 0, transformOrigin: "left", opacity: 0 }}
            animate={{ scaleX: 1, opacity: 1 }}
            transition={{ delay: 3.5, duration: 0.3 }}
          />

          {/* Node 3: Immediate Execution */}
          <motion.div 
            className="absolute left-[80%] flex flex-col items-center z-10"
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 3.8, type: "spring", stiffness: 200 }}
          >
            <div className="relative">
              <div className="w-24 h-24 rounded-full bg-brand-primary text-brand-bg flex items-center justify-center shadow-[0_0_50px_rgba(34,197,94,0.6)]">
                <CheckCircle2 className="w-12 h-12" />
              </div>
              <motion.div 
                className="absolute inset-0 rounded-full border-2 border-brand-primary"
                initial={{ scale: 1, opacity: 1 }}
                animate={{ scale: 2, opacity: 0 }}
                transition={{ delay: 4, duration: 1.5, repeat: Infinity }}
              />
            </div>
            <div className="mt-4 font-mono text-sm text-center text-brand-primary font-bold text-glow">
              SCRAPER<br/>FIRING NOW
            </div>
          </motion.div>

        </div>

        {/* Data flowing visualization */}
        <motion.div 
          className="absolute bottom-0 w-full h-32 overflow-hidden"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 4.5 }}
        >
          <div className="flex gap-4 items-end h-full font-mono text-xs opacity-40">
            {Array.from({ length: 20 }).map((_, i) => (
              <motion.div
                key={i}
                className="w-1 bg-brand-primary rounded-t-sm"
                initial={{ height: 0 }}
                animate={{ height: ['10%', '100%', '30%', '80%', '20%'] }}
                transition={{ 
                  duration: 2, 
                  repeat: Infinity, 
                  delay: i * 0.1,
                  repeatType: "reverse"
                }}
              />
            ))}
          </div>
        </motion.div>

      </div>
    </motion.div>
  );
}