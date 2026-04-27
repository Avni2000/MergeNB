import React from 'react';
import styles from './Logo.module.css';

interface LogoProps {
  size?: 'small' | 'large';
}

export default function Logo({ size = 'small' }: LogoProps) {
  const sizeClass = size === 'large' ? styles.large : styles.small;
  return (
    <div className={`${styles.logoContainer} ${sizeClass}`}>
      <div className={styles.iconWrapper}>
        <div className={`${styles.cellShape} ${styles.cellLeft}`}></div>
        <div className={`${styles.cellShape} ${styles.cellRight}`}></div>
      </div>
      <div className={styles.logoText}>
        <span className={styles.textMerge}>Merge</span>
        <span className={styles.textNb}>NB</span>
      </div>
    </div>
  );
}
