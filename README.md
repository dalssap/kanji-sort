### Description
ai를 활용하여 학습용 한자 이미지를 읽어서 json 형식으로 정리하는 프로그램

### Dependencies
- node
- gemini sdk

### Setting
- gemini api key 발급
- 발급받은 키를 `GEMINI_API_KEY` 시스템 환경변수로 등록

### How to use
이미지 리스트가 포함된 폴더 경로를 파람으로 전달하여 실행
```
node scanner.js <path to image folder>
```