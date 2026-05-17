import React, { useState, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import Scene1Problem from './scenes/Scene1Problem';
import Scene2OldWay from './scenes/Scene2OldWay';
import Scene3Fix from './scenes/Scene3Fix';
import Scene4Result from './scenes/Scene4Result';

const SCENE_DURATIONS = [7000, 6000, 10000, 12000];

export default function VideoTemplate() {
  const [currentScene, setCurrentScene] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => {
      setCurrentScene((prev) => (prev + 1) % SCENE_DURATIONS.length);
    }, SCENE_DURATIONS[currentScene]);
    
    return () => clearTimeout(timer);
  }, [currentScene]);

  return (
    <div className="w-full h-screen bg-brand-bg text-brand-text overflow-hidden relative font-sans flex items-center justify-center">
      {/* Persistent Background Layer */}
      <div className="absolute inset-0 grid-bg opacity-30 z-0" />
      
      {/* Ambient particles */}
      <div className="absolute inset-0 z-0 pointer-events-none">
        <motion.div 
          className="absolute top-[20%] left-[10%] w-[40vw] h-[40vw] rounded-full bg-brand-primary opacity-[0.03] blur-[100px]"
          animate={{
            x: currentScene === 0 ? 0 : currentScene === 1 ? '30vw' : currentScene === 2 ? '10vw' : '-10vw',
            y: currentScene === 0 ? 0 : currentScene === 1 ? '10vh' : currentScene === 2 ? '-10vh' : '20vh',
            scale: currentScene === 3 ? 1.5 : 1
          }}
          transition={{ duration: 3, ease: "easeInOut" }}
        />
        <motion.div 
          className="absolute bottom-[20%] right-[10%] w-[30vw] h-[30vw] rounded-full bg-brand-error opacity-[0.03] blur-[100px]"
          animate={{
            opacity: currentScene < 2 ? 0.05 : 0,
            scale: currentScene < 2 ? 1 : 0.5
          }}
          transition={{ duration: 2 }}
        />
      </div>

      <div className="relative z-10 w-full h-full">
        <AnimatePresence>
          {currentScene === 0 && <Scene1Problem key="scene1" />}
          {currentScene === 1 && <Scene2OldWay key="scene2" />}
          {currentScene === 2 && <Scene3Fix key="scene3" />}
          {currentScene === 3 && <Scene4Result key="scene4" />}
        </AnimatePresence>
      </div>
    </div>
  );
}