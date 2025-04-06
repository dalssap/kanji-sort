import { GoogleGenAI, createUserContent, createPartFromUri } from "@google/genai";
import fs from 'fs';
import path from 'path';
import { Client } from '@notionhq/client';

const MODEL_NAME = "gemini-2.0-flash";
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const notion = new Client({ auth: process.env.NOTION_API_KEY });

const IMAGE_ANALYSIS_CONDITIONS = [
  "첨부한 이미지를 정리해줘",
  "이미지에 없는 내용은 임의로 추가하지 말아야해, 오직 이미지 내의 내용으로만 정리해줘",
  "이미지에 있는 내용 그대로 정리해줘, 예를 들어 히라가나로 되어있는데 가타카나로 바꾸는 것은 하지말아줘 반대도 마찬가지야",
  "훈독에서 대괄호 []는 제거해서 정리해줘",
  "음독, 훈독, 예외 우측에 해당하는 단어가 정리되어 있으니 잘 맞춰서 정리해야해, 예를들어 음독1 우측에 있는 단어인데, 예외 항목에 정리한다 던지 하는 일이 없도록 해야해",
  "example 에서 예외를 정리할 때 키는 그냥 예외 라는 단어로 정리해줘",
  `다음 JSON 형식으로 정리해줘:
    "한자": {
      "kunon": ["한글 훈음1", "한글 흠운2",...],
      "on": ["일본어 음독1", "일본어 음독2", ...],
      "kun": ["일본어 훈독1", "일본어 훈독2", ...],
      "bushu": ["부수1", "부수2", ...],
      "onExamples": {
        "일본어 음독1": [
          {
            "word": "음독1의 예시 단어1(후리가나는 빼고)",
            "yomikata": "요미카타",
            "meaning": ["뜻1", "뜻2",...]
          }
        ],
        "일본어 음독2": [
          {
            "word": "음독2의 예시 단어1(후리가나는 빼고)",
            "yomikata": "요미카타",
            "meaning": ["뜻1", "뜻2",...]
          }
        ],
        "일본어 음독 예외": [
          {
            "word": "음독 예외 예시 단어1(후리가나는 빼고)",
            "yomikata": "요미카타",
            "meaning": ["뜻1", "뜻2",...]
          }
        ]
      },
      "kunExamples": {
        "일본어 훈독1": [
          {
            "word": "훈독1의 예시 단어1(후리가나는 빼고)",
            "yomikata": "요미카타",
            "meaning": ["뜻1", "뜻2",...]
          }
        ],
        "일본어 훈독2": [
          {
            "word": "훈독2의 예시 단어1(후리가나는 빼고)",
            "yomikata": "요미카타",
            "meaning": ["뜻1", "뜻2",...]
          }
        ],
        "일본어 훈독 예외": [
          {
            "word": "훈독 예외 예시 단어1(후리가나는 빼고)",
            "yomikata": "요미카타",
            "meaning": ["뜻1", "뜻2",...]
          }
        ]
      }
    }`
];

async function downloadImage(url, outputPath) {
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();
  fs.writeFileSync(outputPath, Buffer.from(buffer));
  return outputPath;
}

async function processImageWithRetry(imagePath, maxRetries = 5) {
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`이미지 처리 중 (시도 ${attempt}/${maxRetries}): ${imagePath}`);
      
      const image = await ai.files.upload({
        file: imagePath,
      });

      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: [
          createUserContent([
            IMAGE_ANALYSIS_CONDITIONS.join("\n"),
            createPartFromUri(image.uri, image.mimeType),
          ]),
        ],
      });

      let responseText = response.text;
      if (responseText.startsWith('```json') && responseText.endsWith('```')) {
        responseText = responseText.slice(7, -3);
      } else if (responseText.startsWith('```') && responseText.endsWith('```')) {
        responseText = responseText.slice(3, -3);
      }

      const result = JSON.parse(responseText);
      result.imagePath = path.resolve(imagePath);
      return result; // JSON 객체를 반환합니다 (문자열로 변환하지 않음)
    } catch (error) {
      console.error(`시도 ${attempt}/${maxRetries} 실패:`, error.message);
      lastError = error;
      
      if (attempt < maxRetries) {
        // 재시도 전에 잠시 대기 (지수 백오프)
        const delay = Math.pow(5, attempt) * 1000;
        console.log(`${delay}ms 후 재시도합니다...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError || new Error('이미지 처리 실패');
}

async function processNotionPage(pageId, outputFolder) {
  try {
    console.log(`노션 페이지 ${pageId}에서 이미지를 가져오는 중...`);
    
    // 노션 페이지에서 이미지 블록을 가져옵니다
    const blocks = await notion.blocks.children.list({
      block_id: pageId,
    });

    // 이미지 블록만 필터링합니다
    const imageBlocks = blocks.results.filter(block => block.type === 'image');
    
    if (imageBlocks.length === 0) {
      console.log('페이지에 이미지가 없습니다.');
      return;
    }

    console.log(`페이지에서 ${imageBlocks.length}개의 이미지를 찾았습니다.`);

    // 출력 폴더가 없으면 생성합니다
    if (!fs.existsSync(outputFolder)) {
      fs.mkdirSync(outputFolder, { recursive: true });
    }

    // 먼저 모든 이미지를 다운로드합니다
    const downloadedImages = [];
    for (let i = 0; i < imageBlocks.length; i++) {
      const block = imageBlocks[i];
      const imageUrl = block.image.type === 'external' 
        ? block.image.external.url 
        : block.image.file.url;
      
      const imageName = `notion_image_${i + 1}.png`;
      const imagePath = path.join(outputFolder, imageName);
      
      console.log(`다운로드 중 (${i + 1}/${imageBlocks.length}): ${imageUrl}`);
      await downloadImage(imageUrl, imagePath);
      downloadedImages.push(imagePath);
    }

    console.log('모든 이미지 다운로드 완료. 이제 이미지를 처리합니다.');

    // 다운로드한 이미지를 처리합니다
    const results = [];
    for (let i = 0; i < downloadedImages.length; i++) {
      const imagePath = downloadedImages[i];
      try {
        const result = await processImageWithRetry(imagePath);
        results.push(result);
        console.log(`이미지 처리 완료 (${i + 1}/${downloadedImages.length}): ${imagePath}`);
      } catch (error) {
        console.error(`이미지 처리 실패 (${i + 1}/${downloadedImages.length}): ${imagePath}`, error.message);
      }
    }

    if (results.length === 0) {
      console.log('처리된 이미지가 없습니다.');
      return;
    }

    const timestamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 14);
    const outputFileName = `sortedkanji-${timestamp}.json`;
    const outputPath = path.join(outputFolder, outputFileName);

    // JSON 데이터를 보기 좋게 포맷팅합니다
    const outputContent = JSON.stringify(results, null, 2);
    fs.writeFileSync(outputPath, outputContent);
    console.log(`Results saved to ${outputPath}`);
    console.log(`Processed ${results.length} images from Notion page.`);
    console.log(`JSON 파일 절대 경로: ${path.resolve(outputPath)}`);
  } catch (error) {
    console.error('노션 페이지 처리 중 오류 발생:', error);
  }
}

async function processImagesInFolder(folderPath) {
  try {
    fs.accessSync(folderPath, fs.constants.W_OK);
  } catch (err) {
    console.error(`Error: No write permission for directory ${folderPath}`);
    process.exit(1);
  }

  const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'];
  const files = fs.readdirSync(folderPath)
    .filter(file => {
      // notion_images로 시작하는 폴더는 제외
      if (file.startsWith('notion_images')) {
        return false;
      }
      return imageExtensions.includes(path.extname(file).toLowerCase());
    })
    .sort();

  const results = [];
  for (const file of files) {
    const imagePath = path.join(folderPath, file);
    try {
      const result = await processImageWithRetry(imagePath);
      results.push(result);
      console.log(`이미지 처리 완료: ${imagePath}`);
    } catch (error) {
      console.error(`이미지 처리 실패: ${imagePath}`, error.message);
    }
  }

  if (results.length === 0) {
    console.log('처리된 이미지가 없습니다.');
    return;
  }

  const timestamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 14);
  const outputFileName = `sortedkanji-${timestamp}.json`;
  const outputPath = path.join(folderPath, outputFileName);

  // JSON 데이터를 보기 좋게 포맷팅합니다
  const outputContent = JSON.stringify(results, null, 2);
  fs.writeFileSync(outputPath, outputContent);
  console.log(`Results saved to ${outputPath}`);
  console.log(`Processed ${results.length} images.`);
  console.log(`JSON 파일 절대 경로: ${path.resolve(outputPath)}`);
}

// 명령줄 인수 처리
const args = process.argv.slice(2);
if (args.length === 0) {
  console.log('사용법: node scanner.js [--notion <pageId>] [<folderPath>]');
  process.exit(1);
}

if (args[0] === '--notion' && args.length >= 2) {
  const pageId = args[1];
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 14);
  const outputFolder = args[2] || `./notion_images_${timestamp}`;
  processNotionPage(pageId, outputFolder);
} else {
  const folderPath = args[0] || './images';
  processImagesInFolder(folderPath);
}
