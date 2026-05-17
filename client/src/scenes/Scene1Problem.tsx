import React from 'react';
import { motion } from 'framer-motion';
import { Clock, ServerOff, Database } from 'lucide-react';

export default function Scene1Problem() {
  return (
    <motion.div 
      className="absolute inset-0 flex flex-col items-center justify-center bg-brand-bg/80"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 1.1, filter: "blur(10px)" }}
      transition={{ duration: 0.8 }}
    >
      <div className="w-[80vw] max-w-5xl relative h-[60vh] flex flex-col items-center justify-center">
        
        {/* Timestamp */}
        <motion.div 
          className="absolute top-0 left-0 text-brand-muted font-mono text-xl flex items-center gap-3"
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.5, duration: 0.6 }}
        >
          <Clock className="w-6 h-6 text-brand-error" />
          <span>SYS.TIME: 08:00:00 UTC</span>
        </motion.div>

        {/* The Event */}
        <motion.div 
          className="flex flex-col items-center gap-6"
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 1.5, duration: 0.8, type: "spring" }}
        >
          <div className="relative">
            <ServerOff className="w-32 h-32 text-brand-error" strokeWidth={1} />
            <motion.div 
              className="absolute inset-0 bg-brand-error rounded-full blur-[50px] -z-10"
              initial={{ opacity: 0 }}
              animate={{ opacity: [0, 0.4, 0.2] }}
              transition={{ delay: 2, duration: 2, repeat: Infinity }}
            />
          </div>
          
          <div className="text-center space-y-2">
            <motion.h1 
              className="font-display text-5xl font-bold text-white tracking-tight"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 2.2, duration: 0.5 }}
            >
              CRON WINDOW <span className="text-brand-error text-glow-error">MISSED</span>
            </motion.h1>
            <motion.p 
              className="font-mono text-brand-muted text-lg"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 2.5, duration: 0.5 }}
            >
              Server restarting during scheduled scrape...
            </motion.p>
          </div>
        </motion.div>

        {/* Pipeline Impact */}
        <motion.div 
          className="absolute bottom-0 w-full flex items-center justify-between p-6 border border-brand-error/30 rounded-xl bg-brand-error/5"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 3.5, duration: 0.6 }}
        >
          <div className="flex items-center gap-4">
            <Database className="w-8 h-8 text-brand-muted" />
            <div>
              <div className="text-sm font-mono text-brand-muted">LEAD_PIPELINE.STATUS</div>
              <div className="text-xl font-bold">0 LEADS COLLECTED</div>
            </div>
          </div>
          <motion.div 
            className="px-4 py-2 bg-brand-error/20 text-brand-error border border-brand-error/50 rounded font-mono text-sm"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 4, type: "spring" }}
          >
            [ FAILED ]
          </motion.div>
        </motion.div>

      </div>
    </motion.div>
  );
}