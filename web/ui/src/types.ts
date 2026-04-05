export type BookHit = {
    id: string;
    title: string;
    authors: string[];
    cover_url: string;
    publishers?: string[];
};

export type AuthStatus = {
    valid?: boolean;
    reason?: string | null;
};

export type ChapterRow = {
    index: number;
    title?: string;
    pages?: number;
    minutes?: number;
};

export type ProgressPayload = {
    status?: string;
    percentage?: number;
    eta_seconds?: number;
    current_chapter?: number;
    total_chapters?: number;
    chapter_title?: string;
    error?: string;
    epub?: string;
    pdf?: string | string[];
    markdown?: string;
    plaintext?: string;
    json?: string;
    chunks?: string;
};
